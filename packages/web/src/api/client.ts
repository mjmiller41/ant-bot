import type {
  Bot,
  Thread,
  Approval,
  Rule,
  Skill,
  Routine,
  RoutineRun,
  Attachment,
  Message,
  CreateBotRequest,
  UpdateBotRequest,
  CreateThreadRequest,
  PostMessageRequest,
  ApprovalDecisionRequest,
  CreateRuleRequest,
  CreateRoutineRequest,
  CreateSkillRequest,
  RosterEntry,
  ThreadWithMessages,
  UsageSummary,
  SearchResult,
  Settings,
} from '@antbot/shared';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers:
      init?.body && !(init.body instanceof FormData)
        ? { 'Content-Type': 'application/json', ...(init.headers ?? {}) }
        : init?.headers,
  });
  if (!res.ok) {
    let message = res.statusText;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; code?: string };
      if (body?.error) message = body.error;
      code = body?.code;
    } catch {
      // ignore, keep statusText
    }
    throw new ApiError(message, res.status, code);
  }
  if (res.status === 204) return undefined as T;
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return undefined as T;
  return (await res.json()) as T;
}

function json(body: unknown): RequestInit {
  return { body: JSON.stringify(body) };
}

export const api = {
  health: () => request<{ ok: true; seq: number }>('/health'),

  bots: {
    list: () => request<RosterEntry[]>('/bots'),
    create: (body: CreateBotRequest) => request<Bot>('/bots', { method: 'POST', ...json(body) }),
    get: (id: string) => request<Bot>(`/bots/${id}`),
    update: (id: string, body: UpdateBotRequest) =>
      request<Bot>(`/bots/${id}`, { method: 'PATCH', ...json(body) }),
    remove: (id: string) => request<{ ok: true }>(`/bots/${id}`, { method: 'DELETE' }),
    duplicate: (id: string) => request<Bot>(`/bots/${id}/duplicate`, { method: 'POST' }),
    memory: {
      list: (id: string) => request<{ name: string; content: string }[]>(`/bots/${id}/memory`),
      save: (id: string, name: string, content: string) =>
        request<{ ok: true }>(`/bots/${id}/memory`, { method: 'PUT', ...json({ name, content }) }),
      remove: (id: string, name: string) =>
        request<{ ok: true }>(`/bots/${id}/memory/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    },
    skills: {
      get: (id: string) => request<Skill[]>(`/bots/${id}/skills`),
      set: (id: string, skillIds: string[]) =>
        request<{ ok: true }>(`/bots/${id}/skills`, { method: 'PUT', ...json({ skillIds }) }),
    },
    stop: (id: string) => request<{ stopped: boolean }>(`/bots/${id}/stop`, { method: 'POST' }),
  },

  threads: {
    list: () => request<Thread[]>('/threads'),
    create: (body: CreateThreadRequest) =>
      request<Thread>('/threads', { method: 'POST', ...json(body) }),
    get: (id: string) => request<ThreadWithMessages>(`/threads/${id}`),
    postMessage: (id: string, body: PostMessageRequest) =>
      request<Message>(`/threads/${id}/messages`, { method: 'POST', ...json(body) }),
    markRead: (id: string) => request<{ ok: true }>(`/threads/${id}/read`, { method: 'POST' }),
    remove: (id: string) => request<{ ok: true }>(`/threads/${id}`, { method: 'DELETE' }),
  },

  approvals: {
    list: () => request<Approval[]>('/approvals'),
    decide: (id: string, body: ApprovalDecisionRequest) =>
      request<Approval>(`/approvals/${id}`, { method: 'POST', ...json(body) }),
  },

  rules: {
    list: () => request<Rule[]>('/rules'),
    create: (body: CreateRuleRequest) => request<Rule>('/rules', { method: 'POST', ...json(body) }),
    update: (id: string, enabled: boolean) =>
      request<Rule>(`/rules/${id}`, { method: 'PATCH', ...json({ enabled }) }),
    remove: (id: string) => request<{ ok: true }>(`/rules/${id}`, { method: 'DELETE' }),
  },

  skills: {
    list: () => request<Skill[]>('/skills'),
    create: (body: CreateSkillRequest) =>
      request<Skill>('/skills', { method: 'POST', ...json(body) }),
    get: (id: string) => request<Skill & { bodyMd: string }>(`/skills/${id}`),
    remove: (id: string) => request<{ ok: true }>(`/skills/${id}`, { method: 'DELETE' }),
  },

  routines: {
    list: (botId?: string) =>
      request<Routine[]>(`/routines${botId ? `?botId=${encodeURIComponent(botId)}` : ''}`),
    create: (body: CreateRoutineRequest) =>
      request<Routine>('/routines', { method: 'POST', ...json(body) }),
    update: (id: string, body: Partial<Routine>) =>
      request<Routine>(`/routines/${id}`, { method: 'PATCH', ...json(body) }),
    remove: (id: string) => request<{ ok: true }>(`/routines/${id}`, { method: 'DELETE' }),
    runs: (id: string) => request<RoutineRun[]>(`/routines/${id}/runs`),
    testRun: (id: string) => request<{ runId: string }>(`/routines/${id}/test-run`, { method: 'POST' }),
  },

  attachments: {
    upload: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return request<Attachment>('/attachments', { method: 'POST', body: form });
    },
    url: (id: string) => `/api/attachments/${id}`,
  },

  usage: () => request<UsageSummary>('/usage'),

  search: (q: string) => request<SearchResult[]>(`/search?q=${encodeURIComponent(q)}`),

  settings: {
    get: () => request<Settings>('/settings'),
    update: (body: Partial<Settings>) =>
      request<Settings>('/settings', { method: 'PATCH', ...json(body) }),
  },

  workspace: {
    tree: (path = '') =>
      request<{ name: string; path: string; dir: boolean; bytes: number }[]>(
        `/workspace/tree?path=${encodeURIComponent(path)}`,
      ),
    fileUrl: (path: string) => `/api/workspace/file?path=${encodeURIComponent(path)}`,
  },

  computer: {
    status: () =>
      request<{
        available: boolean;
        mode: string;
        pages: { botId: string; url: string; title: string }[];
      }>('/computer/status'),
    takeover: (botId: string) =>
      request<{ ok: boolean; message: string }>('/computer/takeover', {
        method: 'POST',
        ...json({ botId }),
      }),
    returnControl: (botId: string) =>
      request<{ ok: true }>('/computer/takeover', { method: 'DELETE', ...json({ botId }) }),
  },
};
