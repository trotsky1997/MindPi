/**
 * Built-in hooks extension.
 *
 * Ported from @hsingjui/pi-hooks: a Claude-Code-style hooks system (pi has no
 * native hooks). Reads `settings.hooks` from the agent + project settings and
 * runs configured shell commands on lifecycle/tool/prompt events. When no hooks
 * are configured the event handlers simply find no matching groups and no-op.
 */
import type { ExtensionAPI } from "../../extensions/types.ts";
import { createHookContext } from "./hook-context.ts";
import { registerCompactHooks } from "./hooks/compact-hooks.ts";
import { registerPromptHooks } from "./hooks/prompt-hooks.ts";
import { registerSessionHooks } from "./hooks/session-hooks.ts";
import { registerStopHooks } from "./hooks/stop-hooks.ts";
import { registerToolHooks } from "./hooks/tool-hooks.ts";

export default function hooksExtension(pi: ExtensionAPI): void {
	const shared = createHookContext(pi);

	registerSessionHooks(pi, shared);
	registerCompactHooks(pi, shared);
	registerPromptHooks(pi, shared);
	registerStopHooks(pi, shared);
	registerToolHooks(pi, shared);
}
