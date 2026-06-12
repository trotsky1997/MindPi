import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareHcpRuntime } from "../../src/core/hcp/index.ts";

const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-hcp-env-"));
	tempDirs.push(dir);
	return dir;
}

function writeConfig(dir: string, toml: string): string {
	const path = join(dir, "hcp.toml");
	writeFileSync(path, toml, "utf8");
	return path;
}

function setEnv(key: string, value: string | undefined): void {
	if (!(key in savedEnv)) savedEnv[key] = process.env[key];
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

beforeEach(() => {
	for (const k of ["HCP_FILE_VAR", "HCP_PROC_VAR", "HCP_OPT_VAR", "HCP_PASS_VAR"]) setEnv(k, undefined);
});

afterEach(() => {
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	for (const k of Object.keys(savedEnv)) delete savedEnv[k];
	while (tempDirs.length) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("HCP [env] handling", () => {
	it("loads .env files and exposes required vars", () => {
		const dir = makeDir();
		writeFileSync(join(dir, ".env"), "HCP_FILE_VAR=from_file\n", "utf8");
		const path = writeConfig(dir, 'version = 1\n[env]\nfiles = [".env"]\nrequired = ["HCP_FILE_VAR"]\n');
		const prep = prepareHcpRuntime(path);
		expect(prep.env.HCP_FILE_VAR).toBe("from_file");
	});

	it("process env wins over file when override is not set", () => {
		const dir = makeDir();
		setEnv("HCP_PROC_VAR", "from_process");
		writeFileSync(join(dir, ".env"), "HCP_PROC_VAR=from_file\n", "utf8");
		const path = writeConfig(dir, 'version = 1\n[env]\nfiles = [".env"]\nrequired = ["HCP_PROC_VAR"]\n');
		const prep = prepareHcpRuntime(path);
		expect(prep.env.HCP_PROC_VAR).toBe("from_process");
	});

	it("file wins over process env when override = true", () => {
		const dir = makeDir();
		setEnv("HCP_PROC_VAR", "from_process");
		writeFileSync(join(dir, ".env"), "HCP_PROC_VAR=from_file\n", "utf8");
		const path = writeConfig(
			dir,
			'version = 1\n[env]\nfiles = [".env"]\noverride = true\nrequired = ["HCP_PROC_VAR"]\n',
		);
		const prep = prepareHcpRuntime(path);
		expect(prep.env.HCP_PROC_VAR).toBe("from_file");
	});

	it("[env.set] values always win and are exported", () => {
		const dir = makeDir();
		setEnv("HCP_PROC_VAR", "from_process");
		const path = writeConfig(
			dir,
			'version = 1\n[env]\n[env.set]\nHCP_PROC_VAR = "from_set"\nPI_SKIP_VERSION_CHECK = "1"\n',
		);
		const prep = prepareHcpRuntime(path);
		expect(prep.env.HCP_PROC_VAR).toBe("from_set");
		expect(prep.env.PI_SKIP_VERSION_CHECK).toBe("1");
	});

	it("optional vars are included only when present", () => {
		const dir = makeDir();
		const path = writeConfig(dir, 'version = 1\n[env]\noptional = ["HCP_OPT_VAR"]\n');
		// not set -> absent (no throw)
		expect(prepareHcpRuntime(path).env.HCP_OPT_VAR).toBeUndefined();
		// set -> present
		setEnv("HCP_OPT_VAR", "yes");
		expect(prepareHcpRuntime(path).env.HCP_OPT_VAR).toBe("yes");
	});

	it("offline sets PI_OFFLINE and PI_SKIP_VERSION_CHECK", () => {
		const dir = makeDir();
		const path = writeConfig(dir, "version = 1\n[run]\noffline = true\n");
		const prep = prepareHcpRuntime(path);
		expect(prep.env.PI_OFFLINE).toBe("1");
		expect(prep.env.PI_SKIP_VERSION_CHECK).toBe("1");
	});

	it("throws when a required env file is missing", () => {
		const dir = makeDir();
		const path = writeConfig(dir, 'version = 1\n[env]\nfiles = ["does-not-exist.env"]\n');
		expect(() => prepareHcpRuntime(path)).toThrow(/Environment file not found/);
	});
});
