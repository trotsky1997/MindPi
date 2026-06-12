// ============================================================================
// Hook executor: builds Claude-Code-style JSON input and runs hook commands.
// Ported from @hsingjui/pi-hooks (src/executor.ts).
// ============================================================================
import { spawn } from "node:child_process";
import type { Hook, HookExecutionContext } from "./types.ts";

/** Build the Claude-Code-style JSON input passed to a hook command via stdin. */
export function buildHookInput(ctx: HookExecutionContext): object {
	const base: Record<string, unknown> = {
		session_id: ctx.sessionId,
		cwd: ctx.cwd,
		hook_event_name: ctx.hookEventName,
		transcript_path: ctx.transcriptPath,
	};

	if (ctx.hookEventName === "PreCompact") {
		return {
			...base,
			trigger: ctx.trigger,
			custom_instructions: ctx.customInstructions ?? "",
		};
	}

	if (ctx.hookEventName === "PostCompact") {
		return {
			...base,
			trigger: ctx.trigger,
			compact_summary: ctx.compactSummary,
		};
	}

	if (ctx.hookEventName === "UserPromptSubmit") {
		return {
			...base,
			prompt: ctx.prompt,
		};
	}

	if (ctx.hookEventName === "Stop") {
		return {
			...base,
			stop_hook_active: ctx.stopHookActive ?? false,
			last_assistant_message: ctx.lastAssistantMessage ?? "",
		};
	}

	if (
		ctx.hookEventName === "PreToolUse" ||
		ctx.hookEventName === "PostToolUse" ||
		ctx.hookEventName === "PostToolUseFailure"
	) {
		const toolInput: Record<string, unknown> = {
			...base,
			tool_name: ctx.toolName,
			tool_input: ctx.toolInput,
			tool_use_id: ctx.toolUseId,
		};

		if (ctx.hookEventName === "PostToolUse") {
			toolInput.tool_response = ctx.toolResponse;
		}

		if (ctx.hookEventName === "PostToolUseFailure") {
			toolInput.error = ctx.error;
			if (ctx.isInterrupt !== undefined) {
				toolInput.is_interrupt = ctx.isInterrupt;
			}
		}

		return toolInput;
	}

	if (ctx.hookEventName === "SessionEnd") {
		return {
			...base,
			reason: ctx.reason,
			model: ctx.model,
		};
	}

	return {
		...base,
		source: ctx.source,
		model: ctx.model,
	};
}

export async function executeHook(
	hook: Hook,
	input: object,
	cwd: string,
	timeoutMs = 60000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const inputJson = JSON.stringify(input);
	return executeCommandHook(hook.command, inputJson, cwd, timeoutMs);
}

/**
 * Fire a hook command without waiting for its result. Used for hooks marked
 * `async: true`. Output and failures are surfaced to the optional onComplete
 * callback. (Upstream pi-hooks declared `async` but never implemented it.)
 */
export function executeHookAsync(
	hook: Hook,
	input: object,
	cwd: string,
	timeoutMs = 60000,
	onComplete?: (result: { stdout: string; stderr: string; exitCode: number }) => void,
): void {
	const inputJson = JSON.stringify(input);
	void executeCommandHook(hook.command, inputJson, cwd, timeoutMs).then((result) => {
		onComplete?.(result);
	});
}

function executeCommandHook(
	command: string,
	inputJson: string,
	cwd: string,
	timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve) => {
		const child = spawn("bash", ["-c", command], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let settled = false;

		const finish = (result: { stdout: string; stderr: string; exitCode: number }) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		child.stdout.on("data", (data) => {
			stdout += data.toString();
		});

		child.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		child.stdin.write(inputJson);
		child.stdin.end();

		const timeout = setTimeout(() => {
			child.kill();
			finish({
				stdout,
				stderr: `${stderr}\n[hooks] Hook timed out`.trim(),
				exitCode: 1,
			});
		}, timeoutMs);

		child.on("close", (code) => {
			clearTimeout(timeout);
			finish({
				stdout,
				stderr,
				exitCode: code ?? 1,
			});
		});

		child.on("error", (err) => {
			clearTimeout(timeout);
			finish({
				stdout,
				stderr: err.message,
				exitCode: 1,
			});
		});
	});
}
