import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSystemPrompt, type PromptContext } from './prompt.js';
import { writeMemory } from '../memory/memory.js';
import type { Bot, Skill } from '@antbot/shared';

const makeBot = (over: Partial<Bot> = {}): Bot => ({
  id: 'bot-1', slug: 'assistant', name: 'Assistant', title: 'Ops Lead', description: 'Keep the lights on.',
  avatarEmoji: '🤖', modelTier: 'sonnet', pinned: false, hidden: false, notifications: true,
  sessionId: null, state: 'idle', attention: 'none', threadId: 'thread-1', createdAt: Date.now(), deletedAt: null,
  ...over,
});

const baseCtx = (workspace: string, over: Partial<PromptContext> = {}): PromptContext => ({
  bot: makeBot(),
  workspace,
  skills: [],
  roster: [],
  isGroup: false,
  ...over,
});

describe('buildSystemPrompt', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'antbot-prompt-'));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('includes the bot name, title, description, workspace path and the bot own folder path', () => {
    const bot = makeBot();
    const prompt = buildSystemPrompt(baseCtx(workspace, { bot }));
    expect(prompt).toContain(bot.name);
    expect(prompt).toContain(bot.title);
    expect(prompt).toContain(bot.description);
    expect(prompt).toContain(workspace);
    expect(prompt).toContain(`${workspace}/bots/${bot.slug}/`);
  });

  it('includes the "not a security boundary" shared-computer warning', () => {
    const prompt = buildSystemPrompt(baseCtx(workspace));
    expect(prompt).toContain('security boundary');
    expect(prompt).toContain('**not**');
  });

  it('lists teammates but excludes the bot itself from its own roster', () => {
    const bot = makeBot({ slug: 'self-bot' });
    const roster = [
      { slug: 'self-bot', name: 'Self', title: '' },
      { slug: 'writer', name: 'Writer Bot', title: 'Writer' },
      { slug: 'researcher', name: 'Researcher Bot', title: '' },
    ];
    const prompt = buildSystemPrompt(baseCtx(workspace, { bot, roster }));
    expect(prompt).toContain('## Your teammates');
    expect(prompt).toContain('@writer');
    expect(prompt).toContain('@researcher');
    expect(prompt).not.toContain('@self-bot');
  });

  it('omits the teammates section entirely when the roster has no other members', () => {
    const bot = makeBot({ slug: 'self-bot' });
    const roster = [{ slug: 'self-bot', name: 'Self', title: '' }];
    const prompt = buildSystemPrompt(baseCtx(workspace, { bot, roster }));
    expect(prompt).not.toContain('## Your teammates');
  });

  it('adds the group-conversation section only when isGroup is true', () => {
    const groupPrompt = buildSystemPrompt(baseCtx(workspace, { isGroup: true }));
    expect(groupPrompt).toContain('## Group conversation');

    const dmPrompt = buildSystemPrompt(baseCtx(workspace, { isGroup: false }));
    expect(dmPrompt).not.toContain('## Group conversation');
  });

  it('includes memory content when memory files exist', () => {
    const bot = makeBot({ slug: 'mem-bot' });
    writeMemory(workspace, 'mem-bot', 'preferences', 'Prefers dark mode.');
    const prompt = buildSystemPrompt(baseCtx(workspace, { bot }));
    expect(prompt).toContain('## Your memory');
    expect(prompt).toContain('Prefers dark mode.');
  });

  it('omits the memory heading entirely when there is no memory', () => {
    const bot = makeBot({ slug: 'no-mem-bot' });
    const prompt = buildSystemPrompt(baseCtx(workspace, { bot }));
    expect(prompt).not.toContain('## Your memory');
  });

  it('lists enabled skills when provided', () => {
    const skills: Skill[] = [
      { id: 's1', slug: 'web-search', name: 'Web Search', description: 'Search the web', path: '/skills/web-search', source: 'user', createdAt: 0 },
    ];
    const prompt = buildSystemPrompt(baseCtx(workspace, { skills }));
    expect(prompt).toContain('## Your skills');
    expect(prompt).toContain('**Web Search** (web-search)');
    expect(prompt).toContain('Search the web');
  });

  it('omits the skills section when no skills are provided', () => {
    const prompt = buildSystemPrompt(baseCtx(workspace, { skills: [] }));
    expect(prompt).not.toContain('## Your skills');
  });

  it('always contains the credential/takeover instruction', () => {
    const prompt = buildSystemPrompt(baseCtx(workspace));
    expect(prompt).toContain('Never guess at a credential');
    expect(prompt).toContain('ask the human to take over the computer');
  });

  it('always contains the approval-does-not-undo doctrine', () => {
    const prompt = buildSystemPrompt(baseCtx(workspace));
    expect(prompt).toContain('does not undo');
    expect(prompt).toContain('anything you already did');
  });
});
