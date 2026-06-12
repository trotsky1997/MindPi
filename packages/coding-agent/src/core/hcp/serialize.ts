/**
 * HCP TOML serialization (config object -> TOML text).
 *
 * The inverse of `loadHcpToml`. Useful for generating or round-tripping HCP
 * configs (e.g. emitting a baseline hcp.toml, or tools that mutate a config
 * object and write it back deterministically).
 *
 * `@iarna/toml`'s `stringify` silently drops `undefined` but produces invalid
 * output for `null` and throws on unsupported value types (functions, symbols,
 * bigint). We therefore deep-clean the object first: drop null/undefined,
 * recurse into objects/arrays, and reject anything TOML can't represent.
 */
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import TOML from "@iarna/toml";
import type { HcpConfig } from "./types.ts";
import { ensureDir } from "./utils.ts";

/**
 * Recursively remove null/undefined and validate that every remaining value is
 * TOML-serializable (string, finite number, boolean, Date, or nested
 * object/array of the same). Throws on unsupported types so callers get a clear
 * error rather than `@iarna/toml`'s opaque one. Empty objects/arrays are kept
 * (they serialize to a valid empty table/array).
 */
function clean(value: unknown, path: string): unknown {
	if (value === null || value === undefined) return undefined;

	const t = typeof value;
	if (t === "string" || t === "boolean") return value;
	if (t === "number") {
		if (!Number.isFinite(value as number)) {
			throw new Error(`HCP serialize: non-finite number at ${path}`);
		}
		return value;
	}
	if (value instanceof Date) return value;

	if (Array.isArray(value)) {
		const out: unknown[] = [];
		for (let i = 0; i < value.length; i++) {
			const cleaned = clean(value[i], `${path}[${i}]`);
			// TOML arrays cannot contain null/undefined holes; drop them.
			if (cleaned !== undefined) out.push(cleaned);
		}
		return out;
	}

	if (t === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			const cleaned = clean(v, path ? `${path}.${k}` : k);
			if (cleaned !== undefined) out[k] = cleaned;
		}
		return out;
	}

	throw new Error(`HCP serialize: unsupported value type "${t}" at ${path}`);
}

/**
 * Serialize an HCP config object to TOML text. Defaults `version` to 1 when
 * absent (HCP requires version 1) and rejects any other version.
 */
export function dumpHcpToml(config: HcpConfig): string {
	const version = config.version ?? 1;
	if (version !== 1) throw new Error(`Unsupported HCP version: ${String(version)}`);

	// Ensure `version` is emitted first and present.
	const normalized = { version, ...config } as Record<string, unknown>;
	const cleaned = clean(normalized, "") as Record<string, unknown>;
	// @iarna/toml's stringify accepts a JsonMap (unexported); the cleaned object
	// contains only TOML-serializable values, so cast through the call.
	return TOML.stringify(cleaned as Parameters<typeof TOML.stringify>[0]);
}

/** Serialize an HCP config to TOML and write it to `path` (creating parents). */
export function writeHcpToml(path: string, config: HcpConfig): void {
	ensureDir(dirname(path));
	writeFileSync(path, dumpHcpToml(config), "utf8");
}
