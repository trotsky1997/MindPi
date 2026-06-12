/**
 * Small helpers for HCP config translation. Ported from trotsky1997/pi-hcp
 * (src/utils.ts) and reformatted to match this repo's style.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asBool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

export function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

export function stringList(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	if (typeof value === "string")
		return value
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	return [];
}

export function stringRecord(value: unknown): Record<string, string> {
	if (!isObject(value)) return {};
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string") out[key] = item;
		else if (typeof item === "number" || typeof item === "boolean") out[key] = String(item);
	}
	return out;
}

export function section(root: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = root[key];
	return isObject(value) ? value : {};
}

export function mergedSection(root: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of keys) Object.assign(out, section(root, key));
	return out;
}

export function expandTilde(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

export function resolvePath(path: string, base: string): string {
	const expanded = expandTilde(path);
	return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

export function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true });
}

export function writeJson(path: string, value: unknown, mode?: number): void {
	ensureDir(dirname(path));
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	if (mode !== undefined) chmodSync(path, mode);
}

export function readJsonIfExists(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const value = JSON.parse(readFileSync(path, "utf8"));
		return isObject(value) ? value : {};
	} catch {
		return {};
	}
}

export function readEnvFile(path: string): Record<string, string> {
	const values: Record<string, string> = {};
	const text = readFileSync(path, "utf8");
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#") || !line.includes("=")) continue;
		const idx = line.indexOf("=");
		const key = line.slice(0, idx).trim();
		let value = line.slice(idx + 1).trim();
		if (!key) continue;
		if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
			value = value.slice(1, -1);
		}
		values[key] = value;
	}
	return values;
}

export function sha256Hex(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function assertInside(target: string, root: string, label: string): void {
	const resolvedTarget = resolve(target);
	const resolvedRoot = resolve(root);
	if (resolvedTarget === resolvedRoot) return;
	const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
	if (!resolvedTarget.startsWith(prefix)) throw new Error(`${label} escapes root: ${target}`);
}

export function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...a };
	for (const [key, value] of Object.entries(b)) {
		const current = out[key];
		if (isObject(current) && isObject(value)) out[key] = deepMerge(current, value);
		else out[key] = value;
	}
	return out;
}

export function dedupe<T>(items: T[], keyFn: (item: T) => string = (item) => String(item)): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const item of items) {
		const key = keyFn(item);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(item);
	}
	return out;
}
