/**
 * Built-in extensions that ship inside pi and can be enabled without a
 * `--extension` path or an `npm:`/`git:` package reference.
 *
 * These were originally separate pi extension packages
 * (`@hsingjui/pi-hooks`, `pi-manage-todo-list`, `pi-mcp-adapter`) that the
 * HCP launcher (`pi-hcp`) pulled in via `settings.packages`. They are now
 * vendored into pi core.
 *
 * They are OPT-IN and OFF BY DEFAULT, so a plain `pi` invocation behaves
 * exactly as before. They are enabled per feature via `BuiltinExtensionOptions`
 * (HCP turns them on; a user can also enable them via settings). When enabled,
 * each factory still cheaply self-detects whether its feature is configured and
 * no-ops otherwise.
 *
 * Enabled built-ins are merged ahead of user-provided extension factories in the
 * resource loader.
 */
import type { ExtensionFactory } from "../extensions/types.ts";
import hooksExtension from "./hooks/index.ts";
import mcpExtension from "./mcp/index.ts";
import todoExtension from "./todo/index.ts";

/**
 * Per-feature enable flags for the built-in extensions. Each defaults to OFF;
 * set a flag to `true` to enable that built-in.
 */
export interface BuiltinExtensionOptions {
	hooks?: boolean;
	mcp?: boolean;
	todo?: boolean;
}

/** Return the factories for the built-ins explicitly enabled in `options`. */
export function getBuiltinExtensionFactories(options: BuiltinExtensionOptions = {}): ExtensionFactory[] {
	const factories: ExtensionFactory[] = [];
	if (options.hooks === true) factories.push(hooksExtension);
	if (options.mcp === true) factories.push(mcpExtension);
	if (options.todo === true) factories.push(todoExtension);
	return factories;
}
