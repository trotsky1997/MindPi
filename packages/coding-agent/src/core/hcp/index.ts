/**
 * Native HCP (Harness Configuration Protocol, RFC-0002) support for pi.
 *
 * Public entry point: `prepareHcpRuntime(configPath, options)` translates an
 * HCP TOML config into pi's native runtime artifacts in-process and returns the
 * agent directory, working directory, environment, and synthetic CLI args to
 * merge into the parsed arguments.
 */

export type { PrepareHcpRuntimeOptions } from "./prepare.ts";
export { loadHcpToml, prepareHcpRuntime, resolveDefaultHcpConfigPath } from "./prepare.ts";
export type { HcpConfig, HcpPreparation, HcpSyntheticArgs } from "./types.ts";
