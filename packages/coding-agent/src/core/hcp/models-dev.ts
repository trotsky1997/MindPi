/**
 * models.dev integration for HCP model configuration.
 *
 * When [model] section contains a `models_dev` field (e.g. "deepseek/deepseek-chat"),
 * this module fetches the corresponding model record from the models.dev catalog
 * and returns default values for context_window, max_tokens, reasoning, tool_call,
 * modalities, cost, etc.
 *
 * The catalog is cached on disk at ~/.pi/models-dev-cache.json (TTL: 24h).
 * If the network is unavailable and no cache exists, lookup returns undefined
 * and HCP falls back to its built-in defaults.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CATALOG_URL = "https://api.models.dev/api.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Shape of a single model entry from models.dev /api.json
export interface ModelsDevModel {
	name?: string;
	family?: string;
	reasoning?: boolean;
	tool_call?: boolean;
	structured_output?: boolean;
	temperature?: boolean;
	attachment?: boolean;
	knowledge?: string;
	status?: "alpha" | "beta" | "deprecated";
	limit?: {
		context?: number;
		input?: number;
		output?: number;
	};
	modalities?: {
		input?: string[];
		output?: string[];
	};
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
		reasoning?: number;
	};
	reasoning_options?: Array<
		{ type: "toggle" } | { type: "effort"; values?: string[] } | { type: "budget_tokens"; min?: number; max?: number }
	>;
}

interface CatalogEntry {
	models?: Record<string, ModelsDevModel>;
}

interface CacheFile {
	fetchedAt: number;
	catalog: Record<string, CatalogEntry>;
}

function cachePath(): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
	return join(home, ".pi", "models-dev-cache.json");
}

function loadCache(): CacheFile | null {
	const p = cachePath();
	if (!existsSync(p)) return null;
	try {
		const raw = JSON.parse(readFileSync(p, "utf8")) as CacheFile;
		if (typeof raw.fetchedAt !== "number" || !raw.catalog) return null;
		return raw;
	} catch {
		return null;
	}
}

function saveCache(catalog: Record<string, CatalogEntry>): void {
	try {
		const entry: CacheFile = { fetchedAt: Date.now(), catalog };
		writeFileSync(cachePath(), JSON.stringify(entry), { encoding: "utf8" });
	} catch {
		// best-effort
	}
}

let _catalogPromise: Promise<Record<string, CatalogEntry> | null> | null = null;

async function fetchCatalog(): Promise<Record<string, CatalogEntry> | null> {
	const cached = loadCache();
	if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
		return cached.catalog;
	}
	try {
		const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(8000) });
		if (!res.ok) return cached?.catalog ?? null;
		const data = (await res.json()) as Record<string, CatalogEntry>;
		saveCache(data);
		return data;
	} catch {
		return cached?.catalog ?? null;
	}
}

function getCatalog(): Promise<Record<string, CatalogEntry> | null> {
	if (!_catalogPromise) _catalogPromise = fetchCatalog();
	return _catalogPromise;
}

/**
 * Look up a models.dev model by its canonical ID (e.g. "deepseek/deepseek-chat",
 * "anthropic/claude-opus-4-6"). The ID format is "<provider>/<model-id>".
 *
 * Returns undefined if the model is not found or the catalog is unavailable.
 */
export async function lookupModelsDevModel(modelId: string): Promise<ModelsDevModel | undefined> {
	const slash = modelId.indexOf("/");
	if (slash === -1) return undefined;
	const providerId = modelId.slice(0, slash);
	const modelKey = modelId.slice(slash + 1);

	const catalog = await getCatalog();
	if (!catalog) return undefined;

	const provider = catalog[providerId];
	if (!provider?.models) return undefined;

	// exact match first
	if (provider.models[modelKey]) return provider.models[modelKey];

	// try case-insensitive match
	const lower = modelKey.toLowerCase();
	for (const [k, v] of Object.entries(provider.models)) {
		if (k.toLowerCase() === lower) return v;
	}

	return undefined;
}

/**
 * Convert a models.dev model record into HCP-compatible default fields.
 * The caller should merge these with lower precedence than explicit HCP fields.
 */
export function modelsDevToHcpDefaults(m: ModelsDevModel): Record<string, unknown> {
	const defaults: Record<string, unknown> = {};

	if (m.limit?.context) defaults.context_window = m.limit.context;
	if (m.limit?.output) defaults.max_tokens = m.limit.output;
	if (typeof m.reasoning === "boolean") defaults.reasoning = m.reasoning;
	if (typeof m.tool_call === "boolean") defaults.tool_call = m.tool_call;
	if (typeof m.temperature === "boolean") defaults.temperature = m.temperature;
	if (typeof m.structured_output === "boolean") defaults.structured_output = m.structured_output;

	if (m.modalities?.input) defaults.input = m.modalities.input;
	if (m.modalities?.output) defaults.output_modalities = m.modalities.output;

	if (m.cost) {
		defaults.cost = {
			...(m.cost.input !== undefined ? { input: m.cost.input } : {}),
			...(m.cost.output !== undefined ? { output: m.cost.output } : {}),
			...(m.cost.cache_read !== undefined ? { cacheRead: m.cost.cache_read } : {}),
			...(m.cost.cache_write !== undefined ? { cacheWrite: m.cost.cache_write } : {}),
			...(m.cost.reasoning !== undefined ? { reasoning: m.cost.reasoning } : {}),
		};
	}

	// Derive compat hints from capabilities
	if (m.reasoning_options) {
		const hasEffort = m.reasoning_options.some((o) => o.type === "effort");
		const hasBudget = m.reasoning_options.some((o) => o.type === "budget_tokens");
		if (hasEffort) defaults._reasoningEffortSupported = true;
		if (hasBudget) defaults._reasoningBudgetSupported = true;
	}

	return defaults;
}
