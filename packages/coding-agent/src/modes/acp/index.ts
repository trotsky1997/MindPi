/**
 * Native ACP (Agent Client Protocol) mode entry.
 *
 * Ported from pi-acp/src/index.ts. Instead of spawning `pi --mode rpc` child
 * processes, this drives the in-process AgentSession through the
 * PiRpcProcess-compatible adapter in `pi-rpc-inprocess.ts`. The ACP server
 * (PiAcpAgent) speaks newline-delimited JSON-RPC.
 *
 * Two transports, matching GitHub Copilot CLI's `--acp` convention:
 *   - stdio (default): one connection over process stdin/stdout.
 *   - TCP (`--acp-port N`): a TCP server; each accepted socket is its own ACP
 *     connection speaking the same NDJSON framing. Best for distributed/remote
 *     setups (e.g. a FastAPI service connecting over a socket).
 */
import { createServer, type Socket } from "node:net";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { getAgentDir } from "../../config.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../core/agent-session-runtime.ts";
import { flushRawStdout, writeRawStdout } from "../../core/output-guard.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { PiAcpAgent } from "./agent.ts";
import { type AcpRuntimeProvider, setAcpRuntimeProvider } from "./pi-rpc-inprocess.ts";

export interface RunAcpModeDeps {
	/** Factory used to mint AgentSession runtimes for ACP-created sessions. */
	createRuntime: CreateAgentSessionRuntimeFactory;
	/** Custom session directory, if configured. */
	sessionDir?: string;
	/** If set, run a TCP server on this port instead of using stdio. */
	port?: number;
	/** Host/interface to bind the TCP server to. Defaults to 127.0.0.1 (loopback). */
	host?: string;
}

/**
 * Install the module-level runtime provider that backs in-process ACP sessions.
 * The initial runtime built by main() is reused for the first session created in
 * the launch cwd; everything else is minted via the factory.
 */
function installRuntimeProvider(initialRuntime: AgentSessionRuntime, deps: RunAcpModeDeps): void {
	let initialConsumed = false;
	const launchCwd = process.cwd();

	const provider: AcpRuntimeProvider = {
		async createRuntime({ cwd, sessionPath }) {
			if (!initialConsumed && !sessionPath && cwd === launchCwd) {
				initialConsumed = true;
				return initialRuntime;
			}
			const agentDir = getAgentDir();
			const sessionManager = sessionPath
				? SessionManager.open(sessionPath, deps.sessionDir, cwd)
				: SessionManager.create(cwd, deps.sessionDir);
			return createAgentSessionRuntime(deps.createRuntime, { cwd, agentDir, sessionManager });
		},
	};
	setAcpRuntimeProvider(provider);
}

/**
 * Run pi as an ACP agent. Uses stdio by default; if `deps.port` is set, runs a
 * TCP server instead.
 */
export async function runAcpMode(initialRuntime: AgentSessionRuntime, deps: RunAcpModeDeps): Promise<never> {
	installRuntimeProvider(initialRuntime, deps);
	if (typeof deps.port === "number") {
		return runAcpTcp(deps.port, deps.host ?? "127.0.0.1");
	}
	return runAcpStdio();
}

/** stdio transport: a single ACP connection over process stdin/stdout. */
function runAcpStdio(): Promise<never> {
	// pi takes over process.stdout (redirecting stray writes to stderr) so they
	// don't corrupt protocol output. The ACP stream must therefore use the raw,
	// preserved stdout writer for its JSON-RPC frames.
	const decoder = new TextDecoder();
	const input = new WritableStream<Uint8Array>({
		write(chunk) {
			writeRawStdout(decoder.decode(chunk, { stream: true }));
			return Promise.resolve();
		},
		async close() {
			await flushRawStdout();
		},
	});
	const output = new ReadableStream<Uint8Array>({
		start(controller) {
			process.stdin.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
			process.stdin.on("end", () => controller.close());
			process.stdin.on("error", (err) => controller.error(err));
		},
	});

	const agent = connect(input, output);

	let shuttingDown = false;
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		try {
			agent.current?.dispose();
		} catch {
			// ignore
		}
		process.exit(0);
	};

	process.stdin.on("end", shutdown);
	process.stdin.on("close", shutdown);
	process.stdin.resume();
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	process.stdout.on("error", () => {
		process.exit(0);
	});

	// Keep the process alive until stdin closes.
	return new Promise<never>(() => {});
}

// PLACEHOLDER_TCP

/**
 * TCP transport: accept connections on host:port; each socket is an independent
 * ACP connection with NDJSON framing (same wire format as stdio). Matches
 * `copilot --acp --port N`.
 */
function runAcpTcp(port: number, host: string): Promise<never> {
	const server = createServer((socket: Socket) => {
		socket.setNoDelay(true);

		// Socket bytes -> ACP input (client -> agent).
		const output = new ReadableStream<Uint8Array>({
			start(controller) {
				socket.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
				socket.on("end", () => {
					try {
						controller.close();
					} catch {
						// already closed
					}
				});
				socket.on("error", (err) => {
					try {
						controller.error(err);
					} catch {
						// already errored/closed
					}
				});
			},
		});

		// ACP output (agent -> client) -> socket bytes.
		const input = new WritableStream<Uint8Array>({
			write(chunk) {
				return new Promise<void>((resolve) => {
					if (socket.destroyed || !socket.writable) return resolve();
					socket.write(Buffer.from(chunk), () => resolve());
				});
			},
			close() {
				if (!socket.destroyed) socket.end();
			},
		});

		const agent = connect(input, output);
		const cleanup = () => {
			try {
				agent.current?.dispose();
			} catch {
				// ignore
			}
		};
		socket.on("close", cleanup);
		socket.on("error", cleanup);
	});

	const shutdown = () => {
		server.close();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	return new Promise<never>((_resolve, reject) => {
		server.once("error", (err) => reject(err));
		server.listen(port, host, () => {
			// Announce readiness on stderr (stdout is reserved for protocol framing
			// in stdio mode; for TCP, stdout is unused but we keep stderr for logs).
			process.stderr.write(`pi ACP server listening on ${host}:${port}\n`);
			// Security: the ACP server is UNAUTHENTICATED and can run tools (bash,
			// file edits) on this host. Binding beyond loopback exposes that to the
			// network — warn loudly.
			const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
			if (!loopback) {
				process.stderr.write(
					`WARNING: ACP server bound to ${host} is reachable off-host and has NO authentication. ` +
						"Anyone who can reach this port can run tools/commands as you. " +
						"Restrict access (firewall/tunnel) or bind to 127.0.0.1.\n",
				);
			}
		});
	});
}

/**
 * Wire a Web stream pair to an ACP AgentSideConnection. Returns a holder whose
 * `.current` is the PiAcpAgent (AgentSideConnection stores it privately, so we
 * keep our own reference to dispose it).
 */
function connect(
	input: WritableStream<Uint8Array>,
	output: ReadableStream<Uint8Array>,
): { current: PiAcpAgent | undefined } {
	const holder: { current: PiAcpAgent | undefined } = { current: undefined };
	const stream = ndJsonStream(input, output);
	const connection = new AgentSideConnection((conn) => {
		holder.current = new PiAcpAgent(conn);
		return holder.current;
	}, stream);
	void connection;
	return holder;
}
