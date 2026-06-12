# ACP mode

pi can act as an [Agent Client Protocol](https://agentclientprotocol.com) (ACP)
agent, so ACP-compatible clients — and the
[hcp-sdk](https://github.com/MindLab-Research/hcp-sdk) — can drive pi
programmatically.

```bash
pi --mode acp                       # stdio (default): one connection over stdin/stdout
pi --mode acp --acp-port 9777       # TCP: listen on 127.0.0.1:9777
pi --mode acp --acp-port 9777 --acp-host 0.0.0.0   # bind all interfaces (see Security)
```

This support is **native and in-process**: pi speaks ACP itself. There is no
separate `pi-acp` process and no internal `pi --mode rpc` child — the ACP server
drives the in-process `AgentSession` directly. It is a port of
[`pi-acp`](https://github.com/svkozak/pi-acp) whose subprocess transport was
replaced with an in-process adapter.

## Transports

Both transports speak the **same** newline-delimited JSON-RPC framing; only the
byte channel differs (matching GitHub Copilot CLI's `--acp` / `--acp --port`
convention):

- **stdio** (default): a single ACP connection over `process.stdin`/`stdout`.
  Best for editor/IDE integration, which launches the agent as a child process.
- **TCP** (`--acp-port N`): a TCP server; each accepted socket is its own ACP
  connection. Best for distributed/remote setups — e.g. a FastAPI service that
  connects over a socket rather than spawning a subprocess. Binds `127.0.0.1`
  by default; override with `--acp-host`. The server prints
  `pi ACP server listening on <host>:<port>` to stderr when ready.

### Connecting from FastAPI (TCP)

Open a socket to the port, write JSON-RPC frames terminated by `\n`, and read
newline-delimited responses and `session/update` notifications:

```python
reader, writer = await asyncio.open_connection("127.0.0.1", 9777)
writer.write(json.dumps({"jsonrpc":"2.0","id":1,"method":"initialize",
    "params":{"protocolVersion":1,"clientCapabilities":{}}}).encode() + b"\n")
await writer.drain()
line = await reader.readline()          # initialize response
# then session/new, session/prompt; stream session/update notifications
```

## Security

The ACP server is **unauthenticated** and can run tools (bash, file edits) on
the host. stdio mode is local by construction. TCP mode binds loopback
(`127.0.0.1`) by default; binding a non-loopback `--acp-host` (e.g. `0.0.0.0`)
exposes an unauthenticated agent to the network and prints a warning. Put it
behind a firewall, SSH tunnel, or devtunnel rather than exposing the port
directly.

## Protocol

pi implements the ACP agent side over newline-delimited JSON-RPC:

- `initialize` — handshake; advertises protocol version, agent info, auth
  methods, and capabilities (`loadSession`, prompt image support, session list).
- `session/new`, `session/load` — create or reattach a session (one in-process
  `AgentSession` each; sessions persist in pi's normal sessions directory).
- `session/prompt` — send a user turn; assistant text, thinking, and tool
  calls/results stream back as `session/update` notifications.
- `session/cancel` — abort the current turn.
- `authenticate` — terminal-login auth method (launches `pi` interactively).
- `session/set_mode` — maps to pi thinking levels.
- `unstable_listSessions` — enumerate sessions for the cwd.

Tool calls stream as ACP `tool_call` / `tool_call_update`; file edits are
surfaced as structured diffs. Slash commands (extension/prompt/skill) are
exposed via `available_commands_update`.

## Relationship to HCP

`pi --hcp config.toml --mode acp` prepares a runtime from an HCP config and then
serves it over ACP — the path the hcp-sdk uses to connect to a fully configured
pi without any external launcher.

## Notes

- ACP owns stdin/stdout; `@file` arguments and piped stdin are not used in this
  mode. Protocol frames are written through pi's raw-stdout path so stray writes
  (redirected to stderr by pi's stdout guard) cannot corrupt the stream.
- If no model/credentials are configured, `initialize` still succeeds and pi
  advertises an auth method rather than exiting.
