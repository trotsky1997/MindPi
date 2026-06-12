import type { ExtensionAPI } from "../../../extensions/types.ts";
import { getHookGroups } from "../config.ts";
import { extractTextFromContent } from "../helpers.ts";
import type { HookModuleContext } from "../hook-context.ts";
import type { HookExecutionContext, NotifyFn, SettingsFile, StopResult } from "../types.ts";
import { appendAdditionalContext, executeParsedHook, getStringField, hookIfMatches } from "./shared.ts";

function findLastAssistantMessageText(messages: unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as {
			role?: string;
			content?: unknown;
		};

		if (message?.role === "assistant") {
			return extractTextFromContent(message.content);
		}
	}

	return "";
}

export async function triggerStopHooks(
	context: HookExecutionContext,
	settings: SettingsFile | undefined,
	notify?: NotifyFn,
): Promise<StopResult> {
	const groups = getHookGroups(settings, "Stop");
	const result: StopResult = { blocked: false };

	for (const group of groups) {
		for (const hook of group.hooks ?? []) {
			if (hook.if && !hookIfMatches(context, hook.if)) continue;

			try {
				const { hookResult, plainStdout, jsonOutput, commonOutput } = await executeParsedHook(
					hook,
					context,
					"Stop",
					notify,
				);

				if (hookResult.exitCode === 0 && jsonOutput) {
					const additionalContext = getStringField(
						commonOutput?.hookSpecificOutput?.additionalContext,
						jsonOutput.additionalContext,
					);

					result.additionalContext = appendAdditionalContext(result.additionalContext, additionalContext);

					if (commonOutput?.systemMessage) {
						notify?.(commonOutput.systemMessage, "warning");
					}

					if (jsonOutput.decision !== undefined && jsonOutput.decision !== "block") {
						notify?.(`Stop ignored invalid decision: ${String(jsonOutput.decision)}`, "warning");
					}

					if (jsonOutput.decision === "block") {
						result.blocked = true;
						result.reason = getStringField(jsonOutput.reason) ?? "Continue requested by Stop hook";
						return result;
					}
				} else if (hookResult.exitCode === 0 && plainStdout) {
					notify?.(`Stop output (non-JSON): ${plainStdout}`, "info");
				}

				if (hookResult.exitCode !== 0) {
					notify?.(`Stop failed (exit ${hookResult.exitCode}): ${hookResult.stderr}`, "error");
				}
			} catch (err) {
				notify?.(`Stop execution error: ${String(err)}`, "error");
			}
		}
	}

	return result;
}

export function registerStopHooks(pi: ExtensionAPI, shared: HookModuleContext) {
	pi.on("agent_end", async (event, ctx) => {
		const result = await triggerStopHooks(
			{
				sessionId: shared.getSessionId(ctx),
				cwd: ctx.cwd,
				hookEventName: "Stop",
				transcriptPath: ctx.sessionManager.getSessionFile(),
				stopHookActive: shared.stopHookActive,
				lastAssistantMessage: findLastAssistantMessageText(event.messages),
			},
			shared.currentSettings,
			(msg, type) => shared.notify(ctx, msg, type),
		);

		if (result.blocked) {
			const continuationMessage = [result.reason, result.additionalContext]
				.filter((value): value is string => Boolean(value?.trim()))
				.join("\n\n");

			shared.stopHookActive = true;
			shared.pi.sendMessage(
				{
					customType: "pi-hooks",
					content: continuationMessage,
					display: false,
					details: {
						hookEventName: "Stop",
						stopHookActive: true,
					},
				},
				{
					deliverAs: "followUp",
					triggerTurn: true,
				},
			);
			return;
		}

		shared.stopHookActive = false;
	});
}
