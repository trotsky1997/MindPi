/**
 * Session snapshot handling for HCP. Ported from trotsky1997/pi-hcp
 * (src/session.ts), with zod schemas replaced by lightweight runtime checks to
 * match this repo's dependency policy.
 *
 * Supports inline snapshots (json / base64 / zlib+base64+json) and external
 * snapshot files, plus detection of pi-session, ATIF, and Qwen35 formats.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateSync } from "node:zlib";
import type { HcpConfig } from "./types.ts";
import { asString, ensureDir, isObject, resolvePath, section } from "./utils.ts";

export type SessionFormat = "pi-session" | "atif" | "qwen35";

export interface SessionRecord {
	version: number;
	id: string;
	messages: Record<string, unknown>[];
	cwd?: string;
	sessionFile?: string;
	activeRetention?: Record<string, unknown>;
}

export function detectSessionFormat(payload: unknown): SessionFormat {
	if (isObject(payload) && typeof payload.schema_version === "string" && payload.schema_version.startsWith("ATIF-"))
		return "atif";
	if (isObject(payload) && typeof payload.id === "string" && Array.isArray(payload.messages) && isObject(payload.meta))
		return "qwen35";
	return "pi-session";
}

function asMessageArray(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	return value.filter(isObject);
}

export function deserializeSessionPayload(payload: unknown, path?: string): SessionRecord {
	const format = detectSessionFormat(payload);
	if (format === "atif") return sessionRecordFromAtif(payload, path);
	if (format === "qwen35") return sessionRecordFromQwen35(payload, path);
	if (!isObject(payload)) throw new Error("Invalid pi session snapshot: expected an object");
	const versionRaw = payload.version;
	const version = typeof versionRaw === "number" && Number.isInteger(versionRaw) ? versionRaw : 1;
	const id = asString(payload.id) ?? asString(payload.sessionId) ?? (path ? basenameNoExt(path) : randomUUID());
	const retention = payload.activeRetention ?? payload.active_retention ?? payload.retention;
	return {
		version,
		id,
		messages: asMessageArray(payload.messages),
		cwd: asString(payload.cwd),
		sessionFile: asString(payload.sessionFile) ?? asString(payload.session_file) ?? path,
		activeRetention: isObject(retention) ? retention : undefined,
	};
}

export function serializeSessionRecord(record: SessionRecord): Record<string, unknown> {
	return {
		version: record.version,
		id: record.id,
		messages: record.messages,
		...(record.cwd ? { cwd: record.cwd } : {}),
		...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
		...(record.activeRetention && Object.keys(record.activeRetention).length
			? { activeRetention: record.activeRetention }
			: {}),
	};
}

export function readSessionPayload(pathOrJson: string, cwd = process.cwd()): unknown {
	const text = pathOrJson.trim().startsWith("{") ? pathOrJson : readFileSync(resolvePath(pathOrJson, cwd), "utf8");
	return JSON.parse(text);
}

export function writeSessionPayload(record: SessionRecord, path: string): void {
	ensureDir(dirname(path));
	writeFileSync(path, `${JSON.stringify(serializeSessionRecord(record), null, 2)}\n`, "utf8");
}

export function decodeSessionSnapshot(session: Record<string, unknown>): unknown | undefined {
	for (const key of ["snapshot_json", "snapshotJson"]) {
		const value = session[key];
		if (typeof value === "string" && value) return JSON.parse(value);
	}
	for (const key of ["snapshot_base64", "snapshotBase64"]) {
		const value = session[key];
		if (typeof value === "string" && value) return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
	}
	const snapshot = session.snapshot;
	if (snapshot === undefined) return undefined;
	if (typeof snapshot === "string") return JSON.parse(snapshot);
	if (!isObject(snapshot))
		throw new Error("session.snapshot must be a table, JSON string, or serialized session payload");
	const content = snapshot.content;
	if (typeof content !== "string" || !content) return snapshot;
	const encoding = String(snapshot.encoding ?? "json").toLowerCase();
	if (encoding === "json") return JSON.parse(content);
	if (encoding === "base64+json" || encoding === "base64")
		return JSON.parse(Buffer.from(content, "base64").toString("utf8"));
	if (encoding === "zlib+base64+json" || encoding === "zlib+base64")
		return JSON.parse(inflateSync(Buffer.from(content, "base64")).toString("utf8"));
	throw new Error(`Unsupported session snapshot encoding: ${encoding}`);
}

export function prepareSessionFromConfig(config: HcpConfig, cwd: string, agentDir: string): string | undefined {
	const session = section(config, "session");
	const mode = asString(session.mode);
	const decoded = decodeSessionSnapshot(session);
	const snapshotPath = asString(session.snapshot_path) ?? asString(session.snapshotPath);
	const explicitPath = asString(session.path) ?? asString(session.session_path) ?? asString(session.sessionPath);
	const sessionDir = asString(session.session_dir) ?? asString(session.sessionDir);

	// in_memory / create: no persistent session file — snapshots still allowed.
	if ((mode === "in_memory" || mode === "create") && !decoded && !snapshotPath) return undefined;

	// continue_recent: find the most recently modified session file and open it.
	if (mode === "continue_recent" && !decoded && !snapshotPath) {
		const dir = sessionDir ? resolvePath(sessionDir, cwd) : join(agentDir, "sessions");
		const recent = findMostRecentSessionFile(dir);
		if (recent) {
			session.mode = "open";
			session.path = recent;
			config.session = session;
			return recent;
		}
		// No session found — fall through to start a new one.
	}

	let record: SessionRecord | undefined;
	if (decoded !== undefined) record = deserializeSessionPayload(decoded);
	else if (snapshotPath)
		record = deserializeSessionPayload(readSessionPayload(snapshotPath, cwd), resolvePath(snapshotPath, cwd));
	if (!record) return explicitPath ? resolvePath(explicitPath, cwd) : undefined;
	if (!record.cwd) record.cwd = cwd;
	const target = explicitPath ? resolvePath(explicitPath, cwd) : join(agentDir, "sessions", `${record.id}.json`);
	record.sessionFile = target;
	writeSessionPayload(record, target);
	session.mode = "open";
	session.path = target;
	config.session = session;
	return target;
}

function findMostRecentSessionFile(dir: string): string | undefined {
	if (!existsSync(dir)) return undefined;
	let best: { path: string; mtime: number } | undefined;
	for (const entry of readdirSync(dir)) {
		if (!/\.(json|jsonl)$/.test(entry)) continue;
		const full = join(dir, entry);
		try {
			const { mtime, isFile } = statSync(full);
			if (!isFile()) continue;
			const ms = mtime.getTime();
			if (!best || ms > best.mtime) best = { path: full, mtime: ms };
		} catch {
			// skip unreadable entries
		}
	}
	return best?.path;
}

function sessionRecordFromAtif(payload: unknown, path?: string): SessionRecord {
	if (!isObject(payload) || typeof payload.schema_version !== "string")
		throw new Error("Invalid ATIF trajectory: missing schema_version");
	const schemaVersion = payload.schema_version;
	const steps = Array.isArray(payload.steps) ? payload.steps.filter(isObject) : [];
	if (!steps.length) throw new Error("Invalid ATIF trajectory: steps must be a non-empty array");
	const agent = isObject(payload.agent) ? payload.agent : {};
	const agentExtra = isObject(agent.extra) && isObject(agent.extra.pi) ? agent.extra.pi : {};
	return {
		version: 1,
		id:
			asString(payload.session_id) ?? asString(payload.trajectory_id) ?? (path ? basenameNoExt(path) : randomUUID()),
		messages: steps.map((step) => atifStepToMessage(step, schemaVersion)),
		cwd: typeof agentExtra.cwd === "string" ? agentExtra.cwd : undefined,
		sessionFile: path,
	};
}

function sessionRecordFromQwen35(payload: unknown, path?: string): SessionRecord {
	if (!isObject(payload) || typeof payload.id !== "string") throw new Error("Invalid Qwen35 record: missing id");
	const messages = Array.isArray(payload.messages) ? payload.messages.filter(isObject) : [];
	if (!messages.length) throw new Error("Invalid Qwen35 record: messages must be a non-empty array");
	const meta = isObject(payload.meta) ? payload.meta : {};
	const pi = isObject(meta.pi) ? meta.pi : {};
	return {
		version: 1,
		id: payload.id,
		messages: messages.map((message) => ({ ...message })),
		cwd: typeof pi.cwd === "string" ? pi.cwd : undefined,
		sessionFile: path,
	};
}

function atifStepToMessage(step: Record<string, unknown>, schemaVersion: string): Record<string, unknown> {
	const extra = isObject(step.extra) && isObject(step.extra.pi) ? step.extra.pi : {};
	if (isObject(extra.rawMessage)) return { ...extra.rawMessage };
	const source = step.source;
	const role = source === "user" ? "user" : source === "agent" ? "assistant" : "system";
	return { role, content: contentToText(step.message), raw: { atifStep: step, atifSchemaVersion: schemaVersion } };
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.map((part) => (isObject(part) && typeof part.text === "string" ? part.text : ""))
			.filter(Boolean)
			.join("\n");
	if (content == null) return "";
	return String(content);
}

function basenameNoExt(path: string): string {
	const base = path.split(/[\\/]/).pop() ?? path;
	return base.replace(/\.[^.]+$/, "");
}
