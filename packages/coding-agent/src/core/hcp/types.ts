/**
 * Types for native HCP (Harness Configuration Protocol, RFC-0002) support.
 *
 * Ported and adapted from trotsky1997/pi-hcp. Unlike pi-hcp, which prepares a
 * runtime directory and spawns a separate `pi-acp` process, this module runs
 * in-process: it translates an HCP TOML config into pi's native runtime
 * artifacts (settings.json, models.json, auth.json, mcp.json, system prompts,
 * sessions) plus a set of synthetic CLI arguments that are merged into the
 * parsed `Args` before pi's normal bootstrap runs.
 */

export type JsonObject = Record<string, unknown>;

export type HcpConfig = JsonObject & {
	version?: number;
	run?: JsonObject;
	js?: JsonObject;
	env?: JsonObject;
	auth?: JsonObject;
	model?: JsonObject;
	provider_options?: JsonObject;
	providerOptions?: JsonObject;
	tools?: unknown;
	extensions?: JsonObject;
	hcp_extensions?: JsonObject;
	skills?: JsonObject;
	prompts?: JsonObject;
	prompt_templates?: JsonObject;
	promptTemplates?: JsonObject;
	themes?: JsonObject;
	resources?: JsonObject;
	workspace?: JsonObject;
	mcp?: unknown;
	hooks?: unknown;
	session?: JsonObject;
	settings?: JsonObject;
};

/**
 * Synthetic CLI arguments derived from an HCP config. These mirror the subset
 * of pi CLI flags that HCP can drive, and are merged into the parsed `Args`.
 */
export interface HcpSyntheticArgs {
	provider?: string;
	model?: string;
	thinking?: string;
	models?: string[];
	tools?: string[];
	noTools?: boolean;
	noBuiltinTools?: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	noContextFiles?: boolean;
	sessionDir?: string;
	session?: string;
}

/**
 * Result of preparing a pi runtime from an HCP config. The caller applies
 * `env`, changes to `cwd`, and merges `syntheticArgs` into the parsed CLI args.
 */
export interface HcpPreparation {
	configPath: string;
	cwd: string;
	agentDir: string;
	env: NodeJS.ProcessEnv;
	syntheticArgs: HcpSyntheticArgs;
	warnings: string[];
}
