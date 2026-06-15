/**
 * Glue between the HCP runtime preparation and pi's CLI bootstrap.
 *
 * `maybePrepareHcp` decides whether an HCP config applies (explicit --hcp flag,
 * or auto-detected default config when no other primary action is requested)
 * and prepares the runtime. `applyHcpPreparation` then applies the prepared
 * environment, changes the working directory, and merges the synthetic args
 * into the parsed CLI args so pi's normal bootstrap consumes them.
 */
import chalk from "chalk";
import type { Args } from "../../cli/args.ts";
import { ENV_AGENT_DIR } from "../../config.ts";
import { type HcpPreparation, prepareHcpRuntime } from "./index.ts";

/**
 * Prepare an HCP runtime when `--hcp` is given. Returns undefined when no HCP
 * config is in play. On preparation failure, prints the error and exits.
 */
export async function maybePrepareHcp(parsed: Args): Promise<HcpPreparation | undefined> {
	// HCP only activates on an explicit flag. We deliberately do NOT auto-detect a
	// stray hcp.toml in the cwd: this is the general `pi` CLI, and silently
	// switching into HCP mode because a file happens to be named hcp.toml would be
	// surprising and unsafe. (pi-hcp auto-detected because it was a dedicated
	// launcher; pi is not.)
	const configPath = parsed.hcp;
	if (!configPath) return undefined;

	try {
		return await prepareHcpRuntime(configPath, { strictWorkspace: parsed.hcpStrictWorkspace });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: failed to prepare HCP runtime from ${configPath}: ${message}`));
		process.exit(1);
	}
}

/**
 * Apply a prepared HCP runtime: export env vars, change cwd, and merge synthetic
 * args into the parsed CLI args. Explicit CLI args take precedence over HCP.
 */
export function applyHcpPreparation(parsed: Args, preparation: HcpPreparation): void {
	for (const [key, value] of Object.entries(preparation.env)) {
		if (value !== undefined) process.env[key] = value;
	}
	// Ensure agent-dir-derived paths point at the HCP agent directory.
	process.env[ENV_AGENT_DIR] = preparation.agentDir;

	if (process.cwd() !== preparation.cwd) {
		process.chdir(preparation.cwd);
	}

	const args = preparation.syntheticArgs;
	if (parsed.provider === undefined && args.provider !== undefined) parsed.provider = args.provider;
	if (parsed.model === undefined && args.model !== undefined) parsed.model = args.model;
	if (parsed.thinking === undefined && args.thinking !== undefined && isThinkingLevel(args.thinking)) {
		parsed.thinking = args.thinking;
	}
	if (parsed.models === undefined && args.models !== undefined) parsed.models = args.models;

	// Tool policy: only one of allowlist / no-tools / no-builtin applies.
	if (
		parsed.tools === undefined &&
		!parsed.noTools &&
		!parsed.noBuiltinTools &&
		(args.tools !== undefined || args.noTools || args.noBuiltinTools)
	) {
		if (args.tools !== undefined) parsed.tools = args.tools;
		else if (args.noTools) parsed.noTools = true;
		else if (args.noBuiltinTools) parsed.noBuiltinTools = true;
	}

	if (parsed.systemPrompt === undefined && args.systemPrompt !== undefined) parsed.systemPrompt = args.systemPrompt;
	if (args.appendSystemPrompt?.length) {
		parsed.appendSystemPrompt = [...(parsed.appendSystemPrompt ?? []), ...args.appendSystemPrompt];
	}
	if (!parsed.noContextFiles && args.noContextFiles) parsed.noContextFiles = true;
	if (parsed.sessionDir === undefined && args.sessionDir !== undefined) parsed.sessionDir = args.sessionDir;
	if (parsed.session === undefined && args.session !== undefined) parsed.session = args.session;

	for (const warning of preparation.warnings) {
		console.error(chalk.yellow(`Warning: ${warning}`));
	}
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function isThinkingLevel(value: string): value is NonNullable<Args["thinking"]> {
	return THINKING_LEVELS.has(value);
}
