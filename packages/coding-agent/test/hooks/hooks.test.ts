import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { matcherMatches } from "../../src/core/builtin-extensions/hooks/config.ts";
import { buildHookInput, executeHook } from "../../src/core/builtin-extensions/hooks/executor.ts";
import {
	extractToolResultPatch,
	hookIfMatches,
	parseJsonOutput,
} from "../../src/core/builtin-extensions/hooks/hooks/shared.ts";
import type { Hook, HookExecutionContext } from "../../src/core/builtin-extensions/hooks/types.ts";

const tempDirs: string[] = [];

function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-hooks-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("matcherMatches", () => {
	it("treats undefined/empty/* as match-all", () => {
		expect(matcherMatches(undefined, "bash")).toBe(true);
		expect(matcherMatches("", "bash")).toBe(true);
		expect(matcherMatches("*", "bash")).toBe(true);
	});

	it("matches by regex", () => {
		expect(matcherMatches("bash", "bash")).toBe(true);
		expect(matcherMatches("ba.*", "bash")).toBe(true);
		expect(matcherMatches("read", "bash")).toBe(false);
	});
});

describe("hookIfMatches", () => {
	const toolCtx: HookExecutionContext = {
		sessionId: "s",
		cwd: "/tmp",
		hookEventName: "PreToolUse",
		toolName: "bash",
		toolInput: { command: "rm -rf /tmp/x" },
	};

	it("matches tool name with no parens", () => {
		expect(hookIfMatches(toolCtx, "Bash")).toBe(true);
		expect(hookIfMatches(toolCtx, "Read")).toBe(false);
	});

	it("matches input glob pattern", () => {
		expect(hookIfMatches(toolCtx, "Bash(rm *)")).toBe(true);
		expect(hookIfMatches(toolCtx, "Bash(ls *)")).toBe(false);
	});

	it("returns false for non-tool events", () => {
		expect(hookIfMatches({ ...toolCtx, hookEventName: "Stop" }, "Bash()")).toBe(false);
	});
});

describe("buildHookInput", () => {
	it("includes tool fields for PreToolUse", () => {
		const input = buildHookInput({
			sessionId: "s",
			cwd: "/tmp",
			hookEventName: "PreToolUse",
			toolName: "bash",
			toolInput: { command: "ls" },
			toolUseId: "t1",
		}) as Record<string, unknown>;
		expect(input.hook_event_name).toBe("PreToolUse");
		expect(input.tool_name).toBe("bash");
		expect(input.tool_use_id).toBe("t1");
	});
});

describe("parseJsonOutput / extractToolResultPatch", () => {
	it("parses JSON and extracts updatedToolResult", () => {
		const json = parseJsonOutput(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PostToolUse",
					updatedToolResult: { content: "patched", isError: true },
				},
			}),
		);
		expect(json).toBeDefined();
		const patch = extractToolResultPatch("PostToolUse", json!);
		expect(patch.content).toBe("patched");
		expect(patch.isError).toBe(true);
	});

	it("returns undefined for non-JSON", () => {
		expect(parseJsonOutput("not json")).toBeUndefined();
	});
});

describe("executeHook", () => {
	it("runs a command and captures stdout + exit code", async () => {
		const dir = makeDir();
		const hook: Hook = { type: "command", command: "cat" };
		const result = await executeHook(hook, { hello: "world" }, dir, 5000);
		expect(result.exitCode).toBe(0);
		// cat echoes the JSON stdin back
		expect(JSON.parse(result.stdout)).toEqual({ hello: "world" });
	});

	it("captures non-zero exit code", async () => {
		const dir = makeDir();
		const hook: Hook = { type: "command", command: "exit 2" };
		const result = await executeHook(hook, {}, dir, 5000);
		expect(result.exitCode).toBe(2);
	});

	it("reads the input file written for the hook", async () => {
		const dir = makeDir();
		writeFileSync(join(dir, "marker"), "x");
		const hook: Hook = { type: "command", command: "ls" };
		const result = await executeHook(hook, {}, dir, 5000);
		expect(result.stdout).toContain("marker");
	});
});
