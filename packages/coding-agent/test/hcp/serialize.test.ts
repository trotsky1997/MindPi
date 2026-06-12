import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadHcpToml } from "../../src/core/hcp/index.ts";
import { dumpHcpToml, writeHcpToml } from "../../src/core/hcp/serialize.ts";
import type { HcpConfig } from "../../src/core/hcp/types.ts";

const tempDirs: string[] = [];
function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-hcp-ser-"));
	tempDirs.push(dir);
	return dir;
}
afterEach(() => {
	while (tempDirs.length) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("dumpHcpToml", () => {
	it("defaults version to 1 and emits it", () => {
		const out = dumpHcpToml({ run: { cwd: "." } } as HcpConfig);
		expect(out).toContain("version = 1");
	});

	it("rejects unsupported versions", () => {
		expect(() => dumpHcpToml({ version: 2 } as HcpConfig)).toThrow(/Unsupported HCP version/);
	});

	it("drops null/undefined and keeps the rest", () => {
		const out = dumpHcpToml({
			version: 1,
			model: { provider: "openai", id: undefined as never, name: null as never },
		} as HcpConfig);
		expect(out).toContain('provider = "openai"');
		expect(out).not.toContain("id =");
		expect(out).not.toContain("name =");
	});

	it("rejects non-finite numbers and unsupported types", () => {
		expect(() => dumpHcpToml({ version: 1, x: Number.NaN } as never)).toThrow(/non-finite/);
		expect(() => dumpHcpToml({ version: 1, fn: () => 0 } as never)).toThrow(/unsupported value type/);
	});

	it("emits nested tables and arrays of tables", () => {
		const out = dumpHcpToml({
			version: 1,
			run: { cwd: ".", agent_dir: ".pi-agent" },
			resources: { embedded: [{ kind: "skill", path: ".pi/skills/x/SKILL.md" }] },
		} as HcpConfig);
		expect(out).toContain("[run]");
		expect(out).toContain("[[resources.embedded]]");
	});
});

describe("round-trip (parse ∘ dump)", () => {
	function roundTrip(config: HcpConfig): HcpConfig {
		const dir = makeDir();
		const path = join(dir, "hcp.toml");
		writeHcpToml(path, config);
		return loadHcpToml(path);
	}

	it("preserves a representative config", () => {
		const config: HcpConfig = {
			version: 1,
			run: { cwd: ".", agent_dir: ".pi-agent", offline: false, verbose: false },
			env: { files: [".env"], required: ["OPENAI_API_KEY"], set: { PI_SKIP_VERSION_CHECK: "1" } },
			model: {
				provider: "openai",
				id: "gpt-4o-mini",
				api: "openai-completions",
				base_url: "https://api.openai.com/v1/",
				api_key_env: "OPENAI_API_KEY",
				context_window: 128000,
				max_tokens: 16000,
				compat: { supportsDeveloperRole: false },
			},
			tools: { allow: ["read", "bash"] },
			resources: {
				system_prompt: "You are a focused coding agent.",
				embedded: [{ kind: "skill", path: ".pi/skills/x/SKILL.md", encoding: "utf-8", content: "# X" }],
			},
			mcp: { servers: { echo: { command: "node", args: ["server.js"] } } },
		} as HcpConfig;

		const back = roundTrip(config);
		expect(back.version).toBe(1);
		expect((back.model as Record<string, unknown>).provider).toBe("openai");
		expect((back.model as Record<string, unknown>).context_window).toBe(128000);
		expect((back.tools as { allow: string[] }).allow).toEqual(["read", "bash"]);
		const embedded = (back.resources as { embedded: Array<Record<string, unknown>> }).embedded;
		expect(embedded[0].kind).toBe("skill");
		const servers = (back.mcp as { servers: Record<string, Record<string, unknown>> }).servers;
		expect(servers.echo.command).toBe("node");
	});

	it("is idempotent (dump∘parse∘dump == parse∘dump)", () => {
		const config: HcpConfig = {
			version: 1,
			run: { cwd: "." },
			model: { provider: "openai", id: "m" },
			tools: { allow: [] },
		} as HcpConfig;
		const dir = makeDir();
		const p1 = join(dir, "a.toml");
		writeHcpToml(p1, config);
		const once = readFileSync(p1, "utf8");
		const reparsed = loadHcpToml(p1);
		expect(dumpHcpToml(reparsed)).toBe(once);
	});
});
