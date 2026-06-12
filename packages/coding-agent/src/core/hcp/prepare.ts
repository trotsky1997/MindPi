/**
 * Native, in-process HCP (Harness Configuration Protocol, RFC-0002) runtime
 * preparation. Ported and adapted from trotsky1997/pi-hcp (src/hcp.ts).
 *
 * Where pi-hcp writes a runtime directory and spawns a separate `pi-acp`
 * process, this module runs inside the pi process: it materializes the same
 * native artifacts (settings.json, models.json, auth.json, mcp.json, sessions)
 * into an HCP agent directory and returns a set of synthetic CLI arguments
 * (model, tools, system prompts, session) that the caller merges into the
 * parsed `Args`. The agent directory is exposed to pi via the
 * PI_CODING_AGENT_DIR environment variable.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import TOML from "@iarna/toml";
import { prepareSessionFromConfig } from "./session.ts";
import type { HcpConfig, HcpPreparation, HcpSyntheticArgs } from "./types.ts";
import {
	asBool,
	asString,
	assertInside,
	dedupe,
	deepMerge,
	ensureDir,
	isObject,
	list,
	mergedSection,
	readEnvFile,
	readJsonIfExists,
	resolvePath,
	section,
	sha256Hex,
	stringList,
	stringRecord,
	writeJson,
} from "./utils.ts";

const DEFAULT_PROVIDER_COMPAT = {
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
};

const DEFAULT_CONFIG_CANDIDATES = ["hcp.toml", "pi-hcp.toml", ".pi/hcp.toml"];

export function loadHcpToml(configPath: string): HcpConfig {
	const text = readFileSync(configPath, "utf8");
	const parsed = TOML.parse(text) as unknown;
	if (!isObject(parsed)) throw new Error("HCP config must be a TOML table");
	const version = parsed.version ?? 1;
	if (version !== 1) throw new Error(`Unsupported HCP version: ${String(version)}`);
	return parsed as HcpConfig;
}

/** Resolve a default HCP config path if one exists in the current directory. */
export function resolveDefaultHcpConfigPath(): string | undefined {
	for (const candidate of DEFAULT_CONFIG_CANDIDATES) {
		const resolved = resolve(candidate);
		if (existsSync(resolved)) return resolved;
	}
	return undefined;
}

export interface PrepareHcpRuntimeOptions {
	cwdOverride?: string;
	strictWorkspace?: boolean;
}

export function prepareHcpRuntime(configPath: string, options: PrepareHcpRuntimeOptions = {}): HcpPreparation {
	const resolvedConfigPath = resolve(configPath);
	const config = loadHcpToml(resolvedConfigPath);
	const warnings: string[] = [];
	const configDir = dirname(resolvedConfigPath);
	const run = section(config, "run");
	const cwd = resolvePath(
		options.cwdOverride ?? asString(run.cwd) ?? asString(config.cwd) ?? ".",
		options.cwdOverride ? process.cwd() : configDir,
	);
	if (!existsSync(cwd)) ensureDir(cwd);

	const agentDir = resolvePath(
		asString(run.agent_dir) ??
			asString(run.agentDir) ??
			asString(config.agent_dir) ??
			asString(config.agentDir) ??
			".pi/hcp-agent",
		cwd,
	);
	ensureDir(agentDir);
	ensureDir(join(cwd, ".pi"));

	materializeEmbeddedResources(config, cwd);
	validateWorkspace(config, cwd, options.strictWorkspace ?? false, warnings);

	const env = buildRuntimeEnv(config, cwd);
	env.PI_CODING_AGENT_DIR = agentDir;

	prepareSessionFromConfig(config, cwd, agentDir);
	const settings = buildSettings(config, cwd);
	writeJson(join(agentDir, "settings.json"), settings);

	const modelsJson = buildModelsJson(config, env);
	if (modelsJson) writeJson(join(agentDir, "models.json"), modelsJson);
	buildAuthJson(config, env, agentDir);
	writeMcpConfig(config, cwd, agentDir, warnings);

	const syntheticArgs = buildSyntheticArgs(config, cwd);

	return { configPath: resolvedConfigPath, cwd, agentDir, env, syntheticArgs, warnings };
}

function buildRuntimeEnv(config: HcpConfig, cwd: string): NodeJS.ProcessEnv {
	const envConfig = section(config, "env");
	const run = section(config, "run");
	let merged: Record<string, string> = { ...process.env } as Record<string, string>;
	let fileValues: Record<string, string> = {};

	for (const raw of stringList(envConfig.files)) {
		const path = resolvePath(raw, cwd);
		if (!existsSync(path)) throw new Error(`Environment file not found: ${path}`);
		fileValues = { ...fileValues, ...readEnvFile(path) };
	}

	merged = envConfig.override === true ? { ...merged, ...fileValues } : { ...fileValues, ...merged };
	const setValues = stringRecord(envConfig.set);
	merged = { ...merged, ...setValues };

	const required = new Set<string>([...stringList(envConfig.required), ...stringList(envConfig.passthrough)]);
	const optional = new Set<string>(stringList(envConfig.optional));
	const model = section(config, "model");
	const directApiKey = typeof (model.api_key ?? model.apiKey) === "string";
	for (const key of ["id_env", "model_env", "modelEnv", "base_url_env", "baseUrlEnv", "api_key_env", "apiKeyEnv"]) {
		if (directApiKey && (key === "api_key_env" || key === "apiKeyEnv")) continue;
		const value = model[key];
		if (typeof value === "string" && value) required.add(value);
	}

	const missing = [...required].filter((name) => !merged[name]);
	if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);

	const out: NodeJS.ProcessEnv = { ...process.env };
	for (const name of required) out[name] = merged[name];
	for (const name of optional) if (merged[name] !== undefined) out[name] = merged[name];
	for (const [key, value] of Object.entries(setValues)) out[key] = value;

	const modelProvider = asString(model.provider);
	const directKey = asString(model.api_key) ?? asString(model.apiKey);
	if (modelProvider && directKey) {
		const envName =
			asString(model.api_key_env) ??
			asString(model.apiKeyEnv) ??
			`PI_HCP_${modelProvider.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_API_KEY`;
		out[envName] = directKey;
		model.api_key_env = envName;
	}

	if (run.offline === true || config.offline === true) {
		out.PI_OFFLINE = "1";
		out.PI_SKIP_VERSION_CHECK = "1";
	}
	return out;
}

function buildSettings(config: HcpConfig, cwd: string): Record<string, unknown> {
	let settings = { ...section(config, "settings") };
	const run = section(config, "run");
	const model = section(config, "model");
	const extensions = section(config, "extensions");
	const skills = section(config, "skills");
	const prompts = mergedSection(config, "prompts", "prompt_templates", "promptTemplates");
	const themes = section(config, "themes");
	const session = section(config, "session");

	if (asString(model.provider)) settings.defaultProvider = asString(model.provider);
	const modelId =
		asString(model.id) ?? asString(model.model) ?? envLookup(model.id_env ?? model.model_env ?? model.modelEnv);
	if (modelId) settings.defaultModel = modelId;
	const thinking =
		asString(model.thinking_level) ??
		asString(model.thinkingLevel) ??
		asString(config.thinking_level) ??
		asString(config.thinkingLevel);
	if (thinking) settings.defaultThinkingLevel = thinking;
	const modelPatterns = stringList(model.models ?? config.models);
	if (modelPatterns.length) settings.enabledModels = modelPatterns;

	if (typeof run.verbose === "boolean") settings.quietStartup = !run.verbose;
	else if (typeof config.verbose === "boolean") settings.quietStartup = !config.verbose;

	const sessionDir = asString(session.session_dir) ?? asString(session.sessionDir);
	if (sessionDir) settings.sessionDir = resolvePath(sessionDir, cwd);

	settings = mergeResourceSettings(settings, "extensions", extensions.paths, cwd);
	settings = mergeResourceSettings(settings, "skills", skills.paths, cwd);
	settings = mergeResourceSettings(settings, "prompts", prompts.paths, cwd);
	settings = mergeResourceSettings(settings, "themes", themes.paths, cwd);

	const packages: unknown[] = [...list(settings.packages)];
	packages.push(...packageEntries(extensions.sources, { skills: [], prompts: [], themes: [] }));
	packages.push(
		...packageEntries(extensions.package_sources ?? extensions.packageSources, {
			skills: [],
			prompts: [],
			themes: [],
		}),
	);
	packages.push(
		...packageEntries(skills.package_sources ?? skills.packageSources, { extensions: [], prompts: [], themes: [] }),
	);
	// MCP, hooks, and todo are native built-in extensions in this fork (no
	// settings.packages / npm: references, unlike pi-hcp). Built-ins are off by
	// default; HCP opts in by listing enabled features in
	// settings.builtinExtensions, honored by the built-in registry. Each built-in
	// still self-detects its config (hooks reads settings.hooks written below; MCP
	// reads mcp.json written by writeMcpConfig).
	const hcpExtensions = section(config, "hcp_extensions");
	if (packages.length) settings.packages = dedupe(packages, (item) => JSON.stringify(item));

	const enabledBuiltins: string[] = [];
	const extensionsEnabled = asBool(extensions.enabled) !== false;
	if (extensionsEnabled && asBool(hcpExtensions.hooks) !== false && config.hooks !== undefined) {
		enabledBuiltins.push("hooks");
	}
	if (extensionsEnabled && asBool(hcpExtensions.mcp) !== false && shouldEnableMcp(config)) {
		enabledBuiltins.push("mcp");
	}
	const todoRequested = asBool(section(config, "tools").todo) === true || asBool(hcpExtensions.todo) === true;
	if (asBool(hcpExtensions.todo) !== false && todoRequested) {
		enabledBuiltins.push("todo");
	}
	if (enabledBuiltins.length) settings.builtinExtensions = enabledBuiltins;

	const extensionPaths = stringList(settings.extensions);
	if (extensionPaths.length) settings.extensions = dedupe(extensionPaths.map((p) => resolvePath(p, cwd)));

	const hooks = normalizeHooks(config.hooks, cwd);
	if (hooks) settings = deepMerge(settings, { hooks });

	return settings;
}

function mergeResourceSettings(
	settings: Record<string, unknown>,
	key: string,
	rawPaths: unknown,
	cwd: string,
): Record<string, unknown> {
	const paths = stringList(rawPaths).map((path) => resolvePath(path, cwd));
	if (!paths.length) return settings;
	const current = stringList(settings[key]);
	return { ...settings, [key]: dedupe([...current, ...paths]) };
}

function packageEntries(raw: unknown, defaults: Record<string, unknown>): unknown[] {
	const out: unknown[] = [];
	for (const item of list(raw)) {
		if (typeof item === "string" && item) out.push({ source: item, ...defaults });
		else if (isObject(item) && typeof item.source === "string") out.push({ ...defaults, ...item });
	}
	return out;
}

function normalizeHooks(raw: unknown, cwd: string): Record<string, unknown> | undefined {
	if (!isObject(raw)) return undefined;
	const source = isObject(raw.hooks) ? raw.hooks : raw;
	const out: Record<string, unknown[]> = {};
	for (const [eventName, rawEvent] of Object.entries(source)) {
		if (Array.isArray(rawEvent)) {
			out[eventName] = rawEvent
				.filter(isObject)
				.map((group) => normalizeHookGroup(group, cwd))
				.filter((group): group is Record<string, unknown> => Boolean(group));
			continue;
		}
		if (!isObject(rawEvent)) continue;
		const groups: unknown[] = [];
		for (const [name, rawGroup] of Object.entries(rawEvent)) {
			if (!isObject(rawGroup)) continue;
			const group = normalizeHookGroup(rawGroup, cwd);
			if (group) groups.push({ name, ...group });
		}
		if (groups.length) out[eventName] = groups;
	}
	return Object.keys(out).length ? out : undefined;
}

function normalizeHookGroup(raw: Record<string, unknown>, cwd: string): Record<string, unknown> | undefined {
	let hooks: Record<string, unknown>[];
	if (Array.isArray(raw.hooks)) hooks = raw.hooks.filter(isObject);
	else if (typeof raw.command === "string") {
		const command = rewriteCommandPath(raw.command, cwd);
		const hook: Record<string, unknown> = { type: raw.type ?? "command", command };
		if (typeof raw.timeout === "number") hook.timeout = raw.timeout;
		if (typeof raw.if === "string") hook.if = raw.if;
		if (typeof raw.condition === "string") hook.if = raw.condition;
		if (raw.async === true || raw.run_async === true) hook.async = true;
		hooks = [hook];
	} else return undefined;
	const group: Record<string, unknown> = { hooks };
	if (typeof raw.matcher === "string") group.matcher = raw.matcher;
	return group;
}

function rewriteCommandPath(command: string, cwd: string): string {
	const parts = command.trim().split(/\s+/);
	if (!parts.length) return command;
	const first = parts[0];
	if ((first.startsWith("./") || first.startsWith("../")) && existsSync(resolvePath(first, cwd))) {
		parts[0] = resolvePath(first, cwd);
		return parts.join(" ");
	}
	return command;
}

/**
 * Translate HCP model/tools/resources/session into pi CLI-equivalent arguments.
 * Unlike pi-hcp (which bakes these into a wrapper script), they are returned as
 * synthetic args merged into the parsed CLI args.
 */
function buildSyntheticArgs(config: HcpConfig, cwd: string): HcpSyntheticArgs {
	const out: HcpSyntheticArgs = {};
	const model = section(config, "model");
	const provider = asString(model.provider);
	const modelId = asString(model.id) ?? asString(model.model);
	const thinking =
		asString(model.thinking_level) ??
		asString(model.thinkingLevel) ??
		asString(config.thinking_level) ??
		asString(config.thinkingLevel);
	if (provider) out.provider = provider;
	if (modelId) out.model = modelId;
	if (thinking) out.thinking = thinking;
	const scopedModels = stringList(model.models ?? config.models);
	if (scopedModels.length) out.models = scopedModels;

	const tools = toolsAllowlist(config);
	const noTools = noToolsMode(config, tools);
	if (tools?.length) out.tools = tools;
	else if (noTools === "all") out.noTools = true;
	else if (noTools === "builtin") out.noBuiltinTools = true;

	const resources = section(config, "resources");
	const systemPrompt = asString(resources.system_prompt) ?? asString(resources.systemPrompt);
	const systemPromptPath = asString(resources.system_prompt_path) ?? asString(resources.systemPromptPath);
	if (systemPrompt !== undefined) out.systemPrompt = systemPrompt;
	else if (systemPromptPath) out.systemPrompt = readFileSync(resolvePath(systemPromptPath, cwd), "utf8");

	const appends: string[] = [];
	appends.push(...stringList(resources.append_system_prompts ?? resources.appendSystemPrompts));
	for (const path of stringList(resources.append_system_prompt_paths ?? resources.appendSystemPromptPaths)) {
		appends.push(readFileSync(resolvePath(path, cwd), "utf8"));
	}
	if (appends.length) out.appendSystemPrompt = appends;

	if (resources.context_files === false || resources.contextFiles === false) out.noContextFiles = true;

	const session = section(config, "session");
	const sessionDir = asString(session.session_dir) ?? asString(session.sessionDir);
	if (sessionDir) out.sessionDir = resolvePath(sessionDir, cwd);
	const sessionPath = asString(session.path) ?? asString(session.session_path) ?? asString(session.sessionPath);
	if ((session.mode === "open" || sessionPath) && sessionPath) out.session = sessionPath;

	return out;
}

function toolsAllowlist(config: HcpConfig): string[] | undefined {
	const raw = config.tools;
	if (Array.isArray(raw)) return stringList(raw);
	if (typeof raw === "string") return stringList(raw);
	if (isObject(raw)) {
		for (const key of ["allow", "enabled", "names"]) {
			if (key in raw) return stringList(raw[key]);
		}
	}
	return undefined;
}

function noToolsMode(config: HcpConfig, tools: string[] | undefined): "all" | "builtin" | undefined {
	const raw = config.tools;
	if (Array.isArray(raw) && raw.length === 0) return "all";
	if (tools?.length) return undefined;
	const top = asString(config.no_tools) ?? asString(config.noTools);
	if (top === "all" || top === "true") return "all";
	if (isObject(raw)) {
		const mode = asString(raw.no_tools) ?? asString(raw.noTools) ?? asString(raw.mode);
		if (mode === "all" || mode === "none") return "all";
		if (raw.enabled === false) return "all";
		for (const key of ["builtin", "builtins", "builtin_tools", "builtinTools"]) {
			if (raw[key] === false) return "builtin";
		}
	}
	return undefined;
}

function buildModelsJson(config: HcpConfig, env: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
	const model = section(config, "model");
	const provider = asString(model.provider);
	const id =
		asString(model.id) ?? asString(model.model) ?? envLookup(model.id_env ?? model.model_env ?? model.modelEnv, env);
	if (!provider || !id) return undefined;
	const needs = [
		"base_url",
		"baseUrl",
		"base_url_env",
		"baseUrlEnv",
		"api",
		"api_type",
		"apiType",
		"llm_api",
		"llmApi",
		"compat",
		"context_window",
		"contextWindow",
		"max_tokens",
		"maxTokens",
		"auth_header",
		"authHeader",
	];
	if (!needs.some((key) => key in model)) return undefined;

	const baseUrl =
		asString(model.base_url) ?? asString(model.baseUrl) ?? envLookup(model.base_url_env ?? model.baseUrlEnv, env);
	const apiKeyEnv = asString(model.api_key_env) ?? asString(model.apiKeyEnv);
	if (!baseUrl) throw new Error("model.base_url or model.base_url_env is required for custom provider models");
	if (!apiKeyEnv) throw new Error("model.api_key_env is required for custom provider models");
	const api =
		asString(model.api) ??
		asString(model.api_type) ??
		asString(model.apiType) ??
		asString(model.llm_api) ??
		asString(model.llmApi) ??
		"openai-completions";
	const compat = deepMerge(DEFAULT_PROVIDER_COMPAT, section(model, "compat"));
	const modelCompat = section(model, "model_compat");
	return {
		providers: {
			[provider]: {
				baseUrl,
				api,
				apiKey: apiKeyEnv,
				authHeader: model.auth_header ?? model.authHeader ?? true,
				compat,
				...(isObject(model.headers) ? { headers: model.headers } : {}),
				models: [
					{
						id,
						name: asString(model.name) ?? id,
						api,
						baseUrl,
						reasoning: model.reasoning === true,
						input: stringList(model.input).length ? stringList(model.input) : ["text"],
						contextWindow: Number(model.context_window ?? model.contextWindow ?? 128000),
						maxTokens: Number(model.max_tokens ?? model.maxTokens ?? 16384),
						cost: isObject(model.cost) ? model.cost : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						compat: Object.keys(modelCompat).length ? deepMerge(compat, modelCompat) : compat,
					},
				],
			},
		},
	};
}

function buildAuthJson(config: HcpConfig, env: NodeJS.ProcessEnv, agentDir: string): void {
	const auth = section(config, "auth");
	const model = section(config, "model");
	const provider = asString(model.provider);
	const apiKey = asString(model.api_key) ?? asString(model.apiKey);
	const apiKeyEnv = asString(model.api_key_env) ?? asString(model.apiKeyEnv);
	const explicitPath = asString(auth.path);
	const authPath = explicitPath ? resolvePath(explicitPath, agentDir) : join(agentDir, "auth.json");
	let data = readJsonIfExists(authPath);
	if (provider && apiKey) data = { ...data, [provider]: { type: "api_key", key: apiKey } };
	else if (provider && apiKeyEnv && !buildModelsJson(config, env) && env[apiKeyEnv])
		data = { ...data, [provider]: { type: "api_key", key: apiKeyEnv } };
	if (Object.keys(data).length) writeJson(authPath, data, 0o600);
}

function writeMcpConfig(config: HcpConfig, cwd: string, agentDir: string, warnings: string[]): void {
	const mcp = config.mcp;
	if (!shouldEnableMcp(config)) return;
	let output: Record<string, unknown> = { mcpServers: {} };
	if (typeof mcp === "string") {
		const path = resolvePath(mcp, cwd);
		if (!existsSync(path)) throw new Error(`MCP config not found: ${path}`);
		output = readJsonIfExists(path);
	} else if (isObject(mcp)) {
		const configPath = asString(mcp.config_path) ?? asString(mcp.configPath);
		if (configPath) output = deepMerge(output, readJsonIfExists(resolvePath(configPath, cwd)));
		const servers = isObject(mcp.servers) ? mcp.servers : isObject(mcp.mcpServers) ? mcp.mcpServers : {};
		const normalizedServers: Record<string, unknown> = {};
		for (const [name, server] of Object.entries(servers)) {
			if (!isObject(server)) continue;
			if (server.placement === "sandbox")
				throw new Error(`MCP server ${name}: placement=sandbox is not supported by the native HCP launcher`);
			normalizedServers[name] = normalizeMcpServer(server, cwd);
		}
		output = deepMerge(output, { mcpServers: normalizedServers });
		if (isObject(mcp.settings)) output = deepMerge(output, { settings: mcp.settings });
		if (Array.isArray(mcp.imports)) output = deepMerge(output, { imports: mcp.imports });
	}
	if (!isObject(output.mcpServers)) warnings.push("MCP config has no mcpServers table");
	writeJson(join(agentDir, "mcp.json"), output);
}

function normalizeMcpServer(server: Record<string, unknown>, cwd: string): Record<string, unknown> {
	const out: Record<string, unknown> = { ...server };
	if (typeof out.cwd === "string") out.cwd = resolvePath(out.cwd, cwd);
	delete out.placement;
	return out;
}

function shouldEnableMcp(config: HcpConfig): boolean {
	if (config.mcp === undefined) return false;
	if (isObject(config.mcp) && config.mcp.enabled === false) return false;
	return true;
}

function materializeEmbeddedResources(config: HcpConfig, cwd: string): void {
	const resources = section(config, "resources");
	const embedded = list(resources.embedded).filter(isObject);
	if (!embedded.length) return;
	const root = resolvePath(asString(resources.embedded_dir) ?? asString(resources.embeddedDir) ?? cwd, cwd);
	ensureDir(root);
	for (const entry of embedded) {
		const rel = asString(entry.path);
		if (!rel) throw new Error("Embedded resource missing path");
		if (rel.startsWith("/") || rel.split(/[\\/]+/).includes(".."))
			throw new Error(`Invalid embedded resource path: ${rel}`);
		const encoding = asString(entry.encoding);
		const content = asString(entry.content);
		const expected = asString(entry.sha256);
		if (!encoding || content === undefined || !expected)
			throw new Error(`Embedded resource ${rel} missing encoding/content/sha256`);
		let bytes: Buffer;
		if (encoding === "utf-8" || encoding === "utf8") bytes = Buffer.from(content, "utf8");
		else if (encoding === "base64") bytes = Buffer.from(content, "base64");
		else throw new Error(`Unsupported embedded resource encoding: ${encoding}`);
		const actual = sha256Hex(bytes);
		if (actual !== expected.toLowerCase()) throw new Error(`Embedded resource checksum mismatch for ${rel}`);
		const target = resolve(root, rel);
		assertInside(target, root, "embedded resource");
		ensureDir(dirname(target));
		writeFileSync(target, bytes);
		applyEmbeddedReference(config, entry, target, cwd);
	}
}

function applyEmbeddedReference(config: HcpConfig, entry: Record<string, unknown>, target: string, cwd: string): void {
	if (entry.auto_discover === true || entry.autoDiscover === true) return;
	const kind = asString(entry.kind);
	if (!kind) return;
	const relOrAbs = target.startsWith(cwd) ? target : resolve(target);
	if (kind === "skill") appendSectionPath(config, "skills", relOrAbs);
	else if (kind === "prompt") appendSectionPath(config, "prompt_templates", relOrAbs);
	else if (kind === "extension") appendSectionPath(config, "extensions", relOrAbs);
	else if (kind === "theme") appendSectionPath(config, "themes", relOrAbs);
	else if (kind === "agents") {
		const resources = section(config, "resources");
		resources.agents_files = dedupe([...stringList(resources.agents_files), relOrAbs]);
		config.resources = resources;
	}
}

function appendSectionPath(config: HcpConfig, sectionName: string, path: string): void {
	const sec = section(config, sectionName);
	sec.paths = dedupe([...stringList(sec.paths), path]);
	config[sectionName] = sec;
}

function validateWorkspace(config: HcpConfig, cwd: string, strict: boolean, warnings: string[]): void {
	const workspace = section(config, "workspace");
	if (!Object.keys(workspace).length) return;
	const root = asString(workspace.root) ?? cwd;
	const names = new Set<string>();
	for (const entry of list(workspace.entries).filter(isObject)) {
		const name = asString(entry.name);
		const source = asString(entry.source);
		const target = asString(entry.target);
		const mode = asString(entry.mode);
		if (!name || !source || !target || !mode)
			throw new Error("workspace.entries items require name/source/target/mode");
		if (names.has(name)) throw new Error(`Duplicate workspace entry: ${name}`);
		names.add(name);
		if (source.startsWith("local:")) {
			const sourcePath = resolvePath(source.slice("local:".length), cwd);
			if (!existsSync(sourcePath) && entry.required !== false)
				throw new Error(`Required workspace source not found: ${sourcePath}`);
		} else if (strict && entry.required !== false && source !== "hcp.resources.embedded") {
			throw new Error(`Workspace source requires staging backend: ${source}`);
		}
		if (!target.startsWith("/")) {
			const resolvedTarget = resolvePath(target, resolvePath(root, cwd));
			assertInside(resolvedTarget, resolvePath(root, cwd), `workspace entry ${name}`);
		}
	}
	const outputNames = new Set<string>();
	for (const output of list(workspace.outputs).filter(isObject)) {
		const name = asString(output.name);
		const path = asString(output.path);
		if (!name || !path) throw new Error("workspace.outputs items require name/path");
		if (outputNames.has(name)) throw new Error(`Duplicate workspace output: ${name}`);
		outputNames.add(name);
	}
	if (!strict)
		warnings.push(
			"workspace manifest was validated but not staged; native HCP runs pi in-process without sandbox staging",
		);
}

function envLookup(value: unknown, env: NodeJS.ProcessEnv = process.env): string | undefined {
	return typeof value === "string" && value ? env[value] : undefined;
}
