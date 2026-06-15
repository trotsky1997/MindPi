import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Args } from "../../src/cli/args.ts";
import { prepareHcpRuntime } from "../../src/core/hcp/index.ts";
import { applyHcpPreparation } from "../../src/core/hcp/integration.ts";

const tempDirs: string[] = [];
const originalCwd = process.cwd();

function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-hcp-int-"));
	tempDirs.push(dir);
	return dir;
}

function baseArgs(overrides: Partial<Args> = {}): Args {
	return {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
		...overrides,
	};
}

afterEach(() => {
	process.chdir(originalCwd);
	while (tempDirs.length) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
	delete process.env.PI_CODING_AGENT_DIR;
});

describe("applyHcpPreparation", () => {
	it("merges synthetic args but lets explicit CLI args win", async () => {
		const dir = makeDir();
		writeFileSync(
			join(dir, "hcp.toml"),
			`version = 1
[model]
provider = "openai"
id = "gpt-4o-mini"
`,
			"utf8",
		);
		const prep = await prepareHcpRuntime(join(dir, "hcp.toml"));
		// User explicitly set a model on the CLI; HCP must not override it.
		const args = baseArgs({ model: "user-chosen-model" });
		applyHcpPreparation(args, prep);
		expect(args.model).toBe("user-chosen-model");
		expect(args.provider).toBe("openai");
		expect(process.env.PI_CODING_AGENT_DIR).toBe(prep.agentDir);
	});
});

describe("todo built-in", () => {
	it("is enabled when tools.todo = true", async () => {
		const dir = makeDir();
		writeFileSync(join(dir, "hcp.toml"), "version = 1\n[tools]\ntodo = true\n", "utf8");
		const prep = await prepareHcpRuntime(join(dir, "hcp.toml"));
		const settings = JSON.parse(readFileSync(join(prep.agentDir, "settings.json"), "utf8")) as {
			packages?: { source: string }[];
			builtinExtensions?: string[];
		};
		expect(settings.packages?.some((p) => p.source === "npm:pi-manage-todo-list")).toBeFalsy();
		expect(settings.builtinExtensions).toContain("todo");
	});

	it("is not enabled for a plain config (built-ins are off by default)", async () => {
		const dir = makeDir();
		writeFileSync(join(dir, "hcp.toml"), 'version = 1\n[model]\nprovider = "openai"\nid = "x"\n', "utf8");
		const prep = await prepareHcpRuntime(join(dir, "hcp.toml"));
		const settings = JSON.parse(readFileSync(join(prep.agentDir, "settings.json"), "utf8")) as {
			builtinExtensions?: string[];
		};
		expect(settings.builtinExtensions ?? []).not.toContain("todo");
	});

	it("is not enabled when [hcp_extensions].todo = false", async () => {
		const dir = makeDir();
		writeFileSync(
			join(dir, "hcp.toml"),
			"version = 1\n[tools]\ntodo = true\n[hcp_extensions]\ntodo = false\n",
			"utf8",
		);
		const prep = await prepareHcpRuntime(join(dir, "hcp.toml"));
		const settings = JSON.parse(readFileSync(join(prep.agentDir, "settings.json"), "utf8")) as {
			builtinExtensions?: string[];
		};
		expect(settings.builtinExtensions ?? []).not.toContain("todo");
	});
});
