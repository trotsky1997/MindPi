import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMcpConfig } from "../../src/core/builtin-extensions/mcp/config.ts";
import { formatToolName, getServerPrefix, isToolExcluded } from "../../src/core/builtin-extensions/mcp/types.ts";
import { interpolateEnvVars } from "../../src/core/builtin-extensions/mcp/utils.ts";

const tempDirs: string[] = [];

function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-mcp-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
	delete process.env.MCP_TEST_VAR;
	delete process.env.PI_CODING_AGENT_DIR;
});

describe("getServerPrefix / formatToolName", () => {
	it("prefixes by full server name (underscored)", () => {
		expect(getServerPrefix("my-server", "server")).toBe("my_server");
		expect(formatToolName("run", "my-server", "server")).toBe("my_server_run");
	});

	it("short mode strips -mcp suffix", () => {
		expect(getServerPrefix("xcodebuild-mcp", "short")).toBe("xcodebuild");
	});

	it("none mode omits prefix", () => {
		expect(formatToolName("run", "srv", "none")).toBe("run");
	});
});

describe("isToolExcluded", () => {
	it("matches by raw and prefixed name", () => {
		expect(isToolExcluded("run", "srv", "server", ["srv_run"])).toBe(true);
		expect(isToolExcluded("run", "srv", "server", ["run"])).toBe(true);
		expect(isToolExcluded("run", "srv", "server", ["other"])).toBe(false);
		expect(isToolExcluded("run", "srv", "server", [])).toBe(false);
	});
});

describe("interpolateEnvVars", () => {
	const DOLLAR = "$";
	it("substitutes brace and env-prefixed variables", () => {
		process.env.MCP_TEST_VAR = "secret123";
		expect(interpolateEnvVars(`token=${DOLLAR}{MCP_TEST_VAR}`)).toBe("token=secret123");
		expect(interpolateEnvVars(`token=${DOLLAR}env:MCP_TEST_VAR`)).toBe("token=secret123");
	});

	it("replaces unknown vars with empty string", () => {
		expect(interpolateEnvVars(`x=${DOLLAR}{DEFINITELY_UNSET_VAR_XYZ}`)).toBe("x=");
	});
});

describe("loadMcpConfig", () => {
	it("loads a project .mcp.json with servers", () => {
		const dir = makeDir();
		writeFileSync(
			join(dir, ".mcp.json"),
			JSON.stringify({
				mcpServers: { echo: { command: "node", args: ["server.js"] } },
				settings: { toolPrefix: "short" },
			}),
			"utf8",
		);
		const config = loadMcpConfig(undefined, dir);
		expect(config.mcpServers.echo.command).toBe("node");
		expect(config.settings?.toolPrefix).toBe("short");
	});

	it("loads from the agent dir mcp.json (PI_CODING_AGENT_DIR)", () => {
		const dir = makeDir();
		const agentDir = makeDir();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { fromagent: { command: "true" } } }),
			"utf8",
		);
		const config = loadMcpConfig(undefined, dir);
		expect(config.mcpServers.fromagent).toBeDefined();
	});
});
