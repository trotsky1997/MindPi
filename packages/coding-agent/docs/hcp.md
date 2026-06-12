# Native HCP support

pi can launch directly from an [HCP (Harness Configuration Protocol, RFC-0002)](https://github.com/MindLab-Research/hcp-sdk)
TOML config. HCP describes a complete agent runtime — model/provider, environment,
tools, resources, MCP servers, hooks, and session state — in a single shareable
file. This implementation is **native and in-process**: pi parses the TOML and
builds its own runtime directly. There is no separate launcher and no `pi-acp`
subprocess.

It is a port of [`trotsky1997/pi-hcp`](https://github.com/trotsky1997/pi-hcp)
into pi itself, preserving that project's section-by-section translation while
running inside the pi process.

## Usage

```bash
pi --hcp hcp.toml                 # launch from an explicit config
pi --hcp hcp.toml --hcp-dry-run   # prepare artifacts + print metadata, then exit
pi --hcp hcp.toml --hcp-strict-workspace
```

HCP activates only when you pass `--hcp <file>`. pi does not auto-detect a
stray `hcp.toml` in the working directory — plain `pi` is never silently
switched into HCP mode.

`--hcp-dry-run` writes the runtime artifacts and prints a JSON summary
(`configPath`, `cwd`, `agentDir`, `envKeys`, `syntheticArgs`, `warnings`) without
starting a session — useful for validating a config.

## What happens

Preparation runs before pi reads any agent-directory-derived paths:

1. Parse and version-gate the TOML (`version = 1`).
2. Resolve `[run].cwd` and `[run].agent_dir` (default `.pi/hcp-agent`), and
   `chdir` into the working directory.
3. Materialize `[resources].embedded` files (validated by SHA-256, with
   path-traversal protection).
4. Validate `[workspace]` (validation only — no staging).
5. Build the runtime environment from `[env]` (files, `required`/`optional`/
   `passthrough`/`set`, model API-key injection) and apply it to the process.
6. Write native pi artifacts into the agent directory: `settings.json`,
   `models.json`, `auth.json` (mode `0600`), `mcp.json`, and any seeded session.
7. Point pi at the agent directory via `PI_CODING_AGENT_DIR`.
8. Merge synthetic CLI args (model, tools, system prompts, session) into the
   parsed arguments. **Explicit CLI flags always take precedence over HCP.**

## Section mapping

| HCP section | Native pi target |
| --- | --- |
| `[run]` | cwd / agent dir / `PI_OFFLINE` / `quietStartup` |
| `[env]` | process environment + model API-key injection |
| `[model]` | `defaultProvider`/`defaultModel`/`defaultThinkingLevel`/`enabledModels`, `models.json`, `auth.json` |
| `[tools]` | `--tools` / `--no-tools` / `--no-builtin-tools` |
| `[resources]` | system prompt + appended prompts, `noContextFiles`, embedded materialization |
| `[skills]` / `[prompts]` / `[themes]` / `[extensions]` | `settings.{skills,prompts,themes,extensions}` + `settings.packages` |
| `[mcp]` | `mcp.json` (+ `pi-mcp-adapter` package) |
| `[hooks]` | `settings.hooks` (+ `@hsingjui/pi-hooks` package) |
| `[session]` | seeded/opened session (pi-session, ATIF, Qwen35 snapshots) |
| `[workspace]` | validated only (warns; no staging) |
| `[hcp_extensions]` | enable/disable the hooks/mcp/todo built-ins |

## MCP, hooks, and todo

These three features are **native built-in extensions** in this fork — vendored
into pi core (`src/core/builtin-extensions/`), always available, no `npm:`
package reference and no separate install. They originated as the
`pi-mcp-adapter`, `@hsingjui/pi-hooks`, and `pi-manage-todo-list` packages.

- `[mcp]` → written to `mcp.json`; the MCP built-in connects servers, registers
  their tools, and handles OAuth/sampling/elicitation/UI.
- `[hooks]` → normalized into `settings.hooks`; the hooks built-in runs them.
- todo → the `manage_todo_list` tool + widget, always on.

Each built-in self-detects its config (no `mcp.json` ⇒ MCP no-ops, no
`settings.hooks` ⇒ hooks no-op). `[hcp_extensions]` flags
(`hooks`/`mcp`/`todo = false`) disable a built-in even when configured; HCP
records these in `settings.hcpDisabledBuiltins`, honored by the built-in
registry. `placement = "sandbox"` MCP servers are rejected (no sandbox backend
in the in-process launcher).

## Secrets

Shareable HCP files must not contain secret values. `models.json` stores only the
**name** of the API-key environment variable, never the key itself. A direct
`model.api_key` is written to `auth.json` (mode `0600`) and exported into the
runtime environment under a generated `PI_HCP_<PROVIDER>_API_KEY` name. Embedded
resources never carry secrets.

## Programmatic API

The `core/hcp` module both reads and writes HCP TOML:

- `loadHcpToml(path)` — parse + version-gate a config file into an `HcpConfig`.
- `dumpHcpToml(config)` — serialize an `HcpConfig` back to TOML text (defaults
  `version` to 1; drops `null`/`undefined`; rejects non-finite numbers and
  non-TOML value types). `writeHcpToml(path, config)` writes it to disk.
- `prepareHcpRuntime(path, opts)` — the full translation into native artifacts.

Parse/serialize round-trips: `loadHcpToml` of a `dumpHcpToml` output reproduces
the config, and `dumpHcpToml` is idempotent across a parse.
