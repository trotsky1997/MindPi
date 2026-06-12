import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadHcpToml, prepareHcpRuntime } from "../../src/core/hcp/index.ts";

const tempDirs: string[] = [];

function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-hcp-test-"));
	tempDirs.push(dir);
	return dir;
}

function writeConfig(dir: string, toml: string, name = "hcp.toml"): string {
	const path = join(dir, name);
	writeFileSync(path, toml, "utf8");
	return path;
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8"));
}

afterEach(() => {
	while (tempDirs.length) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
	delete process.env.OPENAI_API_KEY;
});

describe("loadHcpToml", () => {
	it("parses a version 1 config", () => {
		const dir = makeDir();
		const path = writeConfig(dir, 'version = 1\n[run]\ncwd = "."\n');
		const config = loadHcpToml(path);
		expect(config.version).toBe(1);
	});

	it("defaults version to 1 when omitted", () => {
		const dir = makeDir();
		const path = writeConfig(dir, '[run]\ncwd = "."\n');
		expect(loadHcpToml(path).version ?? 1).toBe(1);
	});

	it("rejects unsupported versions", () => {
		const dir = makeDir();
		const path = writeConfig(dir, "version = 2\n");
		expect(() => loadHcpToml(path)).toThrow(/Unsupported HCP version/);
	});
});

describe("prepareHcpRuntime - model + env", () => {
	it("builds settings, models.json, and env from a minimal openai config", () => {
		const dir = makeDir();
		writeFileSync(join(dir, ".env"), "OPENAI_API_KEY=sk-from-file\n", "utf8");
		const path = writeConfig(
			dir,
			`version = 1
[run]
cwd = "."
agent_dir = ".pi-agent"
[env]
files = [".env"]
override = true
required = ["OPENAI_API_KEY"]
[model]
provider = "openai"
id = "gpt-4o-mini"
api = "openai-completions"
base_url = "https://api.openai.com/v1/"
api_key_env = "OPENAI_API_KEY"
context_window = 128000
max_tokens = 16000
[tools]
allow = []
`,
		);
		const prep = prepareHcpRuntime(path);
		const settings = readJson(join(prep.agentDir, "settings.json"));
		expect(settings.defaultProvider).toBe("openai");
		expect(settings.defaultModel).toBe("gpt-4o-mini");

		const models = readJson(join(prep.agentDir, "models.json")) as {
			providers: Record<string, { apiKey: string; baseUrl: string }>;
		};
		// Secret is referenced by env var name, never inlined.
		expect(models.providers.openai.apiKey).toBe("OPENAI_API_KEY");
		expect(models.providers.openai.baseUrl).toBe("https://api.openai.com/v1/");

		expect(prep.env.OPENAI_API_KEY).toBe("sk-from-file");
		expect(prep.env.PI_CODING_AGENT_DIR).toBe(prep.agentDir);
		expect(prep.syntheticArgs.provider).toBe("openai");
		expect(prep.syntheticArgs.model).toBe("gpt-4o-mini");
	});

	it("throws when a required env var is missing", () => {
		const dir = makeDir();
		const path = writeConfig(
			dir,
			`version = 1
[env]
required = ["MISSING_REQUIRED_VAR_XYZ"]
`,
		);
		expect(() => prepareHcpRuntime(path)).toThrow(/Missing required environment variables/);
	});

	it("injects a direct api_key as a generated env var", () => {
		const dir = makeDir();
		const path = writeConfig(
			dir,
			`version = 1
[model]
provider = "novita"
id = "some-model"
api_key = "sk-direct-secret"
`,
		);
		const prep = prepareHcpRuntime(path);
		expect(prep.env.PI_HCP_NOVITA_API_KEY).toBe("sk-direct-secret");
		// Direct keys land in auth.json (0600), not models.json.
		const auth = readJson(join(prep.agentDir, "auth.json")) as Record<string, { key: string }>;
		expect(auth.novita.key).toBe("sk-direct-secret");
	});
});

describe("prepareHcpRuntime - tools", () => {
	function toolArgs(toml: string) {
		const dir = makeDir();
		const path = writeConfig(dir, `version = 1\n${toml}`);
		return prepareHcpRuntime(path).syntheticArgs;
	}

	it("maps an allowlist to tools", () => {
		expect(toolArgs('[tools]\nallow = ["read", "bash"]\n').tools).toEqual(["read", "bash"]);
	});

	it("maps an empty array to noTools", () => {
		expect(toolArgs("tools = []\n").noTools).toBe(true);
	});

	it("maps builtin = false to noBuiltinTools", () => {
		expect(toolArgs("[tools]\nbuiltin = false\n").noBuiltinTools).toBe(true);
	});
});

describe("prepareHcpRuntime - embedded resources", () => {
	function embeddedConfig(content: string, sha: string): string {
		return `version = 1
[resources]
embedded_dir = ".hcp-embedded"
[[resources.embedded]]
kind = "skill"
path = ".pi/skills/risk/SKILL.md"
encoding = "utf-8"
content = """${content}"""
sha256 = "${sha}"
`;
	}

	it("materializes embedded content with a valid sha256", () => {
		const dir = makeDir();
		const content = "# Risk Skill";
		const sha = createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
		const path = writeConfig(dir, embeddedConfig(content, sha));
		const prep = prepareHcpRuntime(path);
		const target = join(prep.cwd, ".hcp-embedded", ".pi/skills/risk/SKILL.md");
		expect(readFileSync(target, "utf8")).toBe(content);
		const settings = readJson(join(prep.agentDir, "settings.json")) as { skills?: string[] };
		expect(settings.skills?.some((s) => s.endsWith("SKILL.md"))).toBe(true);
	});

	it("rejects a checksum mismatch", () => {
		const dir = makeDir();
		const path = writeConfig(dir, embeddedConfig("# Risk Skill", "0".repeat(64)));
		expect(() => prepareHcpRuntime(path)).toThrow(/checksum mismatch/);
	});

	it("rejects a path traversal attempt", () => {
		const dir = makeDir();
		const content = "x";
		const sha = createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
		const path = writeConfig(
			dir,
			`version = 1
[resources]
[[resources.embedded]]
kind = "skill"
path = "../escape.md"
encoding = "utf-8"
content = "${content}"
sha256 = "${sha}"
`,
		);
		expect(() => prepareHcpRuntime(path)).toThrow(/Invalid embedded resource path/);
	});
});

describe("prepareHcpRuntime - mcp + hooks", () => {
	it("writes mcp.json and enables the adapter package", () => {
		const dir = makeDir();
		const path = writeConfig(
			dir,
			`version = 1
[mcp]
[mcp.settings]
toolPrefix = "x"
[mcp.servers.echo]
command = "node"
args = ["server.js"]
`,
		);
		const prep = prepareHcpRuntime(path);
		const mcp = readJson(join(prep.agentDir, "mcp.json")) as {
			mcpServers: Record<string, { command: string }>;
		};
		expect(mcp.mcpServers.echo.command).toBe("node");
		// MCP is a native built-in; no npm package is injected, and it is opted in
		// via settings.builtinExtensions.
		const settings = readJson(join(prep.agentDir, "settings.json")) as {
			packages?: { source: string }[];
			builtinExtensions?: string[];
		};
		expect(settings.packages?.some((p) => p.source === "npm:pi-mcp-adapter")).toBeFalsy();
		expect(settings.builtinExtensions).toContain("mcp");
	});

	it("rejects sandbox placement", () => {
		const dir = makeDir();
		const path = writeConfig(
			dir,
			`version = 1
[mcp]
[mcp.servers.echo]
command = "node"
placement = "sandbox"
`,
		);
		expect(() => prepareHcpRuntime(path)).toThrow(/placement=sandbox is not supported/);
	});

	it("normalizes hooks into settings (hooks is a native built-in)", () => {
		const dir = makeDir();
		const path = writeConfig(
			dir,
			`version = 1
[hooks.PreToolUse.audit]
matcher = "bash"
command = "echo audit"
timeout = 2
run_async = true
`,
		);
		const prep = prepareHcpRuntime(path);
		const settings = readJson(join(prep.agentDir, "settings.json")) as {
			hooks?: { PreToolUse: { name: string; matcher: string; hooks: { command: string; async?: boolean }[] }[] };
			packages?: { source: string }[];
		};
		const group = settings.hooks?.PreToolUse[0];
		expect(group?.name).toBe("audit");
		expect(group?.matcher).toBe("bash");
		expect(group?.hooks[0].command).toBe("echo audit");
		expect(group?.hooks[0].async).toBe(true);
		// Hooks is a native built-in; no npm package is injected, opted in via settings.
		expect(settings.packages?.some((p) => p.source === "npm:@hsingjui/pi-hooks")).toBeFalsy();
		expect((settings as { builtinExtensions?: string[] }).builtinExtensions).toContain("hooks");
	});

	it("enables built-ins via settings.builtinExtensions, honoring [hcp_extensions]", () => {
		const dir = makeDir();
		const path = writeConfig(
			dir,
			`version = 1
[hcp_extensions]
mcp = false
[mcp]
[mcp.servers.echo]
command = "node"
[hooks.PreToolUse.a]
command = "echo hi"
`,
		);
		const prep = prepareHcpRuntime(path);
		const settings = readJson(join(prep.agentDir, "settings.json")) as { builtinExtensions?: string[] };
		// hooks present -> enabled; mcp present but disabled by flag -> not enabled.
		expect(settings.builtinExtensions).toContain("hooks");
		expect(settings.builtinExtensions ?? []).not.toContain("mcp");
	});
});

describe("prepareHcpRuntime - workspace", () => {
	it("validates and warns without staging", () => {
		const dir = makeDir();
		writeFileSync(join(dir, "data.txt"), "hi", "utf8");
		const path = writeConfig(
			dir,
			`version = 1
[workspace]
root = "."
[[workspace.entries]]
name = "data"
source = "local:data.txt"
target = "data.txt"
mode = "copy"
`,
		);
		const prep = prepareHcpRuntime(path);
		expect(prep.warnings.some((w) => w.includes("not staged"))).toBe(true);
	});

	it("throws on a missing required local source", () => {
		const dir = makeDir();
		const path = writeConfig(
			dir,
			`version = 1
[workspace]
[[workspace.entries]]
name = "data"
source = "local:does-not-exist.txt"
target = "data.txt"
mode = "copy"
`,
		);
		expect(() => prepareHcpRuntime(path)).toThrow(/Required workspace source not found/);
	});
});
