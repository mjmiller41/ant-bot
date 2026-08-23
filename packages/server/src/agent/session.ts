import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ModelTier, Settings } from '@antbot/shared';
import { logger } from '../util/log.js';

const log = logger('agent');

export interface TurnEvent {
  kind: 'text' | 'tool_start' | 'tool_result' | 'session' | 'done' | 'error' | 'status';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  result?: string;
  isError?: boolean;
  sessionId?: string;
  usage?: { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number };
  message?: string;
}

export interface TurnRequest {
  prompt: string;
  /** Prior SDK session to resume so context compounds across turns. */
  resumeSessionId?: string | null;
  modelTier: ModelTier;
  systemPrompt: string;
  cwd: string;
  settings: Settings;
  /** Extra directories the agent may read/write beyond cwd. */
  additionalDirectories?: string[];
  canUseTool?: Options['canUseTool'];
  mcpServers?: Options['mcpServers'];
  abortController?: AbortController;
  /** Root of the local plugin that carries installed skills. */
  skillPluginPath?: string;
  /**
   * Skill names this bot may use. `[]` means none — the SDK hides unlisted skills from
   * the model's listing and the Skill tool rejects them. Note this is a context filter,
   * not a sandbox: skill files stay readable via Read/Bash, so never put secrets in one.
   */
  enabledSkills?: string[];
}

/** `sonnet`/`opus`/`haiku` are CLI model aliases; keep routing fixed per surface. */
export function resolveModel(tier: ModelTier): string {
  return tier;
}

/**
 * Build the environment for the CLI subprocess.
 *
 * The daemon never holds Anthropic credentials: the SDK spawns the `claude` CLI,
 * which uses the user's existing subscription OAuth login. An ANTHROPIC_API_KEY in
 * the ambient environment would silently switch billing to metered API usage, so we
 * strip it unless the user explicitly opted into API billing (plan §9).
 */
export function buildEnv(settings: Settings, base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  if (settings.billingMode !== 'api') {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return env;
}

/**
 * Run one turn and yield normalized events. The caller owns persistence; this
 * wrapper only translates the SDK's message stream into our vocabulary.
 */
export async function* runTurn(req: TurnRequest): AsyncGenerator<TurnEvent> {
  const abort = req.abortController ?? new AbortController();
  const options: Options = {
    model: resolveModel(req.modelTier),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: req.systemPrompt },
    cwd: req.cwd,
    additionalDirectories: req.additionalDirectories,
    abortController: abort,
    includePartialMessages: true,
    permissionMode: 'default',
    canUseTool: req.canUseTool,
    mcpServers: req.mcpServers,
    env: buildEnv(req.settings),
    // Do not inherit the user's own Claude Code project settings into bot turns.
    settingSources: [],
    maxTurns: 60,
  };
  if (req.resumeSessionId) options.resume = req.resumeSessionId;
  // Load skills as a local plugin so the model gets the real `Skill` tool rather than a
  // pile of paths to read, then narrow to the ones assigned to this bot.
  if (req.skillPluginPath) {
    options.plugins = [{ type: 'local', path: req.skillPluginPath }];
    options.skills = req.enabledSkills ?? [];
  }

  let q: ReturnType<typeof query>;
  try {
    q = query({ prompt: req.prompt, options });
  } catch (err) {
    yield { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    return;
  }

  const seenToolIds = new Set<string>();

  try {
    for await (const msg of q as AsyncGenerator<SDKMessage>) {
      const m = msg as Record<string, any>;
      switch (m.type) {
        case 'system':
          if (m.subtype === 'init' && m.session_id) yield { kind: 'session', sessionId: m.session_id };
          break;

        case 'stream_event': {
          const ev = m.event;
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text)
            yield { kind: 'text', text: ev.delta.text };
          break;
        }

        case 'assistant': {
          for (const block of m.message?.content ?? []) {
            if (block.type === 'tool_use' && !seenToolIds.has(block.id)) {
              seenToolIds.add(block.id);
              yield { kind: 'tool_start', toolName: block.name, toolInput: block.input, toolUseId: block.id };
            }
          }
          break;
        }

        case 'user': {
          for (const block of m.message?.content ?? []) {
            if (block.type === 'tool_result') {
              const content = Array.isArray(block.content)
                ? block.content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
                : typeof block.content === 'string'
                  ? block.content
                  : '';
              yield {
                kind: 'tool_result',
                toolUseId: block.tool_use_id,
                result: content.slice(0, 4000),
                isError: Boolean(block.is_error),
              };
            }
          }
          break;
        }

        case 'result': {
          const u = m.usage ?? {};
          yield {
            kind: 'done',
            sessionId: m.session_id,
            text: typeof m.result === 'string' ? m.result : undefined,
            isError: m.subtype !== 'success',
            usage: {
              model: m.modelUsage ? Object.keys(m.modelUsage)[0] ?? resolveModel(req.modelTier) : resolveModel(req.modelTier),
              inputTokens: u.input_tokens ?? 0,
              outputTokens: u.output_tokens ?? 0,
              cacheReadTokens: u.cache_read_input_tokens ?? 0,
              costUsd: m.total_cost_usd ?? 0,
            },
          };
          break;
        }

        default:
          break;
      }
    }
  } catch (err) {
    if (abort.signal.aborted) {
      yield { kind: 'error', message: 'Interrupted.' };
      return;
    }
    log.error('turn failed', err);
    yield { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}
