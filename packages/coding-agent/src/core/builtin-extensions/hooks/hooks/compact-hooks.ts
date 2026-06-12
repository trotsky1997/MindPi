import type { ExtensionAPI } from "../../../extensions/types.ts";
import type { HookModuleContext } from "../hook-context.ts";
import type { HookExecutionContext, HookRunResult, NotifyFn, SettingsFile } from "../types.ts";
import { triggerSimpleHooks } from "./shared.ts";

async function triggerCompactHooks(
	eventName: "PreCompact" | "PostCompact",
	context: HookExecutionContext,
	settings: SettingsFile | undefined,
	notify?: NotifyFn,
): Promise<HookRunResult> {
	return triggerSimpleHooks(eventName, context.trigger ?? "manual", context, settings, notify);
}

export function registerCompactHooks(pi: ExtensionAPI, shared: HookModuleContext) {
	pi.on("session_before_compact", async (event, ctx) => {
		const trigger: "manual" | "auto" = "manual";
		await triggerCompactHooks(
			"PreCompact",
			{
				sessionId: shared.getSessionId(ctx),
				cwd: ctx.cwd,
				hookEventName: "PreCompact",
				trigger,
				customInstructions: event.customInstructions ?? "",
				transcriptPath: ctx.sessionManager.getSessionFile(),
			},
			shared.currentSettings,
			(msg, type) => shared.notify(ctx, msg, type),
		);
	});

	pi.on("session_compact", async (event, ctx) => {
		const trigger: "manual" | "auto" = "manual";

		await triggerCompactHooks(
			"PostCompact",
			{
				sessionId: shared.getSessionId(ctx),
				cwd: ctx.cwd,
				hookEventName: "PostCompact",
				trigger,
				compactSummary: event.compactionEntry.summary,
				transcriptPath: ctx.sessionManager.getSessionFile(),
			},
			shared.currentSettings,
			(msg, type) => shared.notify(ctx, msg, type),
		);

		await shared.triggerSessionStartHook("compact", ctx);
	});
}
