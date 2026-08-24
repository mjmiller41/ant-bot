// The seam between ant-bot's connector registry and whichever agent runtime executes a turn.
//
// ant-bot owns the registry, the credentials, the per-bot assignment and the health of every MCP
// server. The runtime is handed a finished list and asked to mount it. Today the only runtime is
// the Claude Agent SDK; a Gemini or Codex runtime would implement the same interface and translate
// the same list into its own configuration. Nothing above this line may depend on a runtime.

/** A connector resolved and ready to mount: credentials substituted, nothing left to look up. */
export type MountedConnector =
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers: Record<string, string>; tools?: string[] };

export interface AgentRuntime {
  readonly name: string;
  /** Translate ant-bot's mounted connectors into whatever this runtime accepts. */
  mountConnectors(connectors: Record<string, MountedConnector>): Record<string, unknown>;
}

/**
 * The Claude Agent SDK.
 *
 * Every mounted connector gets `alwaysLoad: true`. Without it the SDK defers MCP tools behind its
 * ToolSearch, which meant a bot had to *find* a connector's tools before it could call one — and a
 * connector that failed to mount looked identical to one that was merely unfound. With it, the
 * tools are in the prompt, and the system prompt's `## Your connectors` block agrees with what the
 * model can actually see.
 */
export class ClaudeRuntime implements AgentRuntime {
  readonly name = 'claude';

  mountConnectors(connectors: Record<string, MountedConnector>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, c] of Object.entries(connectors)) out[name] = { ...c, alwaysLoad: true };
    return out;
  }
}
