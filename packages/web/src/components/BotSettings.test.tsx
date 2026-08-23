import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MODEL_TIERS, type Bot } from '@antbot/shared';
import { BotSettings } from './BotSettings.js';

const listSkills = vi.fn();
const getBotSkills = vi.fn();
const setBotSkills = vi.fn();
const listMemory = vi.fn();
const listRoutines = vi.fn();

vi.mock('../api/client.js', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    skills: { list: () => listSkills() },
    bots: {
      skills: { get: (id: string) => getBotSkills(id), set: (id: string, ids: string[]) => setBotSkills(id, ids) },
      memory: { list: () => listMemory() },
      update: vi.fn(),
    },
    routines: { list: () => listRoutines() },
  },
}));

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1', slug: 'scout', name: 'Scout', title: '', description: '',
    avatarEmoji: '🤖', modelTier: 'sonnet', pinned: false, hidden: false,
    notifications: true, sessionId: null, state: 'idle', attention: 'none',
    threadId: 'thread-1', createdAt: 0, deletedAt: null, ...overrides,
  };
}

const SKILLS = [
  { id: 's1', name: 'Expense Report', description: 'files expenses', createdAt: 0, updatedAt: 0 },
  { id: 's2', name: 'Weekly Digest', description: 'summarises the week', createdAt: 0, updatedAt: 0 },
];

describe('BotSettings — Skills panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listSkills.mockResolvedValue(SKILLS);
    listMemory.mockResolvedValue([]);
    listRoutines.mockResolvedValue([]);
  });

  it('pre-checks the skills already assigned to this bot', async () => {
    getBotSkills.mockResolvedValue([SKILLS[0]]);
    render(
      <BotSettings bot={makeBot()} onClose={vi.fn()} onUpdated={vi.fn()} onDuplicated={vi.fn()} onDeleted={vi.fn()} />,
    );
    const assigned = await screen.findByRole('checkbox', { name: /Expense Report/ });
    const notAssigned = screen.getByRole('checkbox', { name: /Weekly Digest/ });
    await waitFor(() => expect(assigned).toBeChecked());
    expect(notAssigned).not.toBeChecked();
  });

  it('saving without touching anything preserves the existing assignment', async () => {
    getBotSkills.mockResolvedValue([SKILLS[0]]);
    render(
      <BotSettings bot={makeBot()} onClose={vi.fn()} onUpdated={vi.fn()} onDuplicated={vi.fn()} onDeleted={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Expense Report/ })).toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: /save skills/i }));
    await waitFor(() => expect(setBotSkills).toHaveBeenCalledWith('bot-1', ['s1']));
  });

  it('adding a skill sends both the old and the new id', async () => {
    getBotSkills.mockResolvedValue([SKILLS[0]]);
    render(
      <BotSettings bot={makeBot()} onClose={vi.fn()} onUpdated={vi.fn()} onDuplicated={vi.fn()} onDeleted={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Expense Report/ })).toBeChecked());
    fireEvent.click(screen.getByRole('checkbox', { name: /Weekly Digest/ }));
    fireEvent.click(screen.getByRole('button', { name: /save skills/i }));
    await waitFor(() => {
      const [, ids] = setBotSkills.mock.calls[0];
      expect([...ids].sort()).toEqual(['s1', 's2']);
    });
  });

  it('unchecking a skill removes it', async () => {
    getBotSkills.mockResolvedValue([SKILLS[0]]);
    render(
      <BotSettings bot={makeBot()} onClose={vi.fn()} onUpdated={vi.fn()} onDuplicated={vi.fn()} onDeleted={vi.fn()} />,
    );
    const cb = await screen.findByRole('checkbox', { name: /Expense Report/ });
    await waitFor(() => expect(cb).toBeChecked());
    fireEvent.click(cb);
    fireEvent.click(screen.getByRole('button', { name: /save skills/i }));
    await waitFor(() => expect(setBotSkills).toHaveBeenCalledWith('bot-1', []));
  });
});

describe('BotSettings — skill description disclosure', () => {
  const LONG = 'a'.repeat(400);

  beforeEach(() => {
    vi.clearAllMocks();
    listSkills.mockResolvedValue([{ id: 's1', name: 'Deep Research', description: LONG, createdAt: 0, updatedAt: 0 }]);
    getBotSkills.mockResolvedValue([]);
    listMemory.mockResolvedValue([]);
    listRoutines.mockResolvedValue([]);
  });

  async function renderRow() {
    render(
      <BotSettings bot={makeBot()} onClose={vi.fn()} onUpdated={vi.fn()} onDuplicated={vi.fn()} onDeleted={vi.fn()} />,
    );
    return screen.findByRole('button', { name: new RegExp(LONG.slice(0, 20)) });
  }

  it('clamps the description to one line until it is opened', async () => {
    const desc = await renderRow();
    expect(desc.className).toContain('truncate');
    expect(desc).toHaveAttribute('aria-expanded', 'false');
  });

  it('expands to the full description on click, and collapses again', async () => {
    const desc = await renderRow();
    fireEvent.click(desc);
    await waitFor(() => expect(desc).toHaveAttribute('aria-expanded', 'true'));
    expect(desc.className).not.toContain('truncate');

    fireEvent.click(desc);
    await waitFor(() => expect(desc).toHaveAttribute('aria-expanded', 'false'));
  });

  // The row used to be one big <label>, so any click on the description flipped the
  // checkbox. Reading a description must never silently assign the skill.
  it('clicking the description does not toggle the checkbox', async () => {
    const desc = await renderRow();
    const cb = screen.getByRole('checkbox', { name: /Deep Research/ });
    expect(cb).not.toBeChecked();
    fireEvent.click(desc);
    await waitFor(() => expect(desc).toHaveAttribute('aria-expanded', 'true'));
    expect(cb).not.toBeChecked();
  });

  it('still toggles when the skill name itself is clicked', async () => {
    await renderRow();
    const cb = screen.getByRole('checkbox', { name: /Deep Research/ });
    fireEvent.click(screen.getByText('Deep Research'));
    await waitFor(() => expect(cb).toBeChecked());
  });
});

describe('BotSettings — model tier picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listSkills.mockResolvedValue([]);
    listMemory.mockResolvedValue([]);
    listRoutines.mockResolvedValue([]);
  });

  // The picker used to hardcode ['sonnet', 'opus'], so `haiku` was a valid tier in the schema
  // that no user could ever pick. Both pickers now render MODEL_TIERS, and this fails if one
  // of them drifts back to its own list.
  it('offers every tier the contract defines', async () => {
    render(<BotSettings bot={makeBot()} onClose={vi.fn()} onUpdated={vi.fn()} onDuplicated={vi.fn()} onDeleted={vi.fn()} />);
    for (const tier of MODEL_TIERS) {
      expect(await screen.findByRole('button', { name: tier })).toBeInTheDocument();
    }
  });

  it('selects a tier when clicked', async () => {
    render(<BotSettings bot={makeBot()} onClose={vi.fn()} onUpdated={vi.fn()} onDuplicated={vi.fn()} onDeleted={vi.fn()} />);
    const fable = await screen.findByRole('button', { name: 'fable' });
    fireEvent.click(fable);
    await waitFor(() => expect(fable.className).toContain('bg-(--color-accent)'));
  });

  it('starts on the tier the bot already has', async () => {
    render(
      <BotSettings bot={makeBot({ modelTier: 'haiku' })} onClose={vi.fn()} onUpdated={vi.fn()} onDuplicated={vi.fn()} onDeleted={vi.fn()} />,
    );
    const haiku = await screen.findByRole('button', { name: 'haiku' });
    expect(haiku.className).toContain('bg-(--color-accent)');
  });
});
