import { useEffect, useState } from 'react';
import { MODEL_TIERS, type Bot, type Skill, type ApiConnector } from '@antbot/contract';
import { api, ApiError } from '../api/client.js';
import { RoutinesPanel } from './RoutinesPanel.js';
import { EMOJI_CHOICES } from './emoji.js';

export interface BotSettingsProps {
  bot: Bot;
  onClose: () => void;
  onUpdated: (bot: Bot) => void;
  onDuplicated: (bot: Bot) => void;
  onDeleted: (botId: string) => void;
}

function ProfileEditor({ bot, onUpdated }: { bot: Bot; onUpdated: (bot: Bot) => void }) {
  const [name, setName] = useState(bot.name);
  const [title, setTitle] = useState(bot.title);
  const [description, setDescription] = useState(bot.description);
  const [avatarEmoji, setAvatarEmoji] = useState(bot.avatarEmoji);
  const [modelTier, setModelTier] = useState(bot.modelTier);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.bots.update(bot.id, { name, title, description, avatarEmoji, modelTier });
      onUpdated(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setEmojiOpen((v) => !v)}
          className="flex h-12 w-12 items-center justify-center rounded-lg border border-(--color-border) text-2xl hover:bg-(--color-bg-hover)"
        >
          {avatarEmoji}
        </button>
        <div className="flex-1">
          <input
            className="w-full rounded border border-(--color-border) bg-(--color-bg) px-2 py-1.5 text-sm font-medium"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Name"
          />
        </div>
      </div>
      {emojiOpen && (
        <div className="grid grid-cols-10 gap-1 rounded border border-(--color-border) p-2">
          {EMOJI_CHOICES.map((em) => (
            <button
              key={em}
              type="button"
              onClick={() => {
                setAvatarEmoji(em);
                setEmojiOpen(false);
              }}
              className="rounded p-1 text-lg hover:bg-(--color-bg-hover)"
            >
              {em}
            </button>
          ))}
        </div>
      )}
      <label className="block text-xs">
        <span className="mb-1 block text-(--color-text-muted)">Title</span>
        <input
          className="w-full rounded border border-(--color-border) bg-(--color-bg) px-2 py-1.5 text-sm"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="block text-xs">
        <span className="mb-1 block text-(--color-text-muted)">Description / persona</span>
        <textarea
          className="w-full rounded border border-(--color-border) bg-(--color-bg) px-2 py-1.5 text-sm"
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <div>
        <span className="mb-1 block text-xs text-(--color-text-muted)">Model tier</span>
        <div className="inline-flex rounded border border-(--color-border) p-0.5">
          {MODEL_TIERS.map((tier) => (
            <button
              key={tier}
              type="button"
              onClick={() => setModelTier(tier)}
              className={`rounded px-3 py-1 text-xs font-medium capitalize ${
                modelTier === tier ? 'bg-(--color-accent) text-(--color-accent-fg)' : 'text-(--color-text-muted)'
              }`}
            >
              {tier}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="text-xs text-(--color-red)">{error}</p>}
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="rounded bg-(--color-accent) px-3 py-1.5 text-sm font-medium text-(--color-accent-fg) disabled:opacity-40"
      >
        Save profile
      </button>
    </div>
  );
}

function MemoryEditor({ botId }: { botId: string }) {
  const [files, setFiles] = useState<{ name: string; content: string }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [newName, setNewName] = useState('');

  useEffect(() => {
    api.bots.memory.list(botId).then(setFiles);
  }, [botId]);

  function select(name: string) {
    setSelected(name);
    setDraft(files.find((f) => f.name === name)?.content ?? '');
  }

  async function save() {
    const name = selected ?? newName.trim();
    if (!name) return;
    await api.bots.memory.save(botId, name, draft);
    setFiles((cur) => {
      const idx = cur.findIndex((f) => f.name === name);
      if (idx === -1) return [...cur, { name, content: draft }];
      return cur.map((f, i) => (i === idx ? { name, content: draft } : f));
    });
    setSelected(name);
    setNewName('');
  }

  async function remove(name: string) {
    await api.bots.memory.remove(botId, name);
    setFiles((cur) => cur.filter((f) => f.name !== name));
    if (selected === name) {
      setSelected(null);
      setDraft('');
    }
  }

  return (
    <div className="grid grid-cols-[160px_1fr] gap-3">
      <div className="space-y-1">
        {files.map((f) => (
          <div key={f.name} className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => select(f.name)}
              className={`flex-1 truncate rounded px-2 py-1 text-left text-xs ${
                selected === f.name ? 'bg-(--color-accent)/15' : 'hover:bg-(--color-bg-hover)'
              }`}
            >
              {f.name}
            </button>
            <button type="button" onClick={() => remove(f.name)} aria-label={`Delete ${f.name}`} className="text-xs text-(--color-text-faint) hover:text-(--color-red)">
              ×
            </button>
          </div>
        ))}
        <input
          className="w-full rounded border border-(--color-border) bg-(--color-bg) px-2 py-1 text-xs"
          placeholder="new-file.md"
          value={newName}
          onChange={(e) => {
            setNewName(e.target.value);
            setSelected(null);
            setDraft('');
          }}
        />
      </div>
      <div>
        <textarea
          className="h-40 w-full rounded border border-(--color-border) bg-(--color-bg) p-2 font-mono text-xs"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Durable facts this bot should remember…"
        />
        <button
          type="button"
          onClick={save}
          className="mt-2 rounded bg-(--color-accent) px-3 py-1.5 text-xs font-medium text-(--color-accent-fg)"
        >
          Save memory file
        </button>
      </div>
    </div>
  );
}

/**
 * One assignable skill. The description is the problem child: published skills carry
 * multi-sentence descriptions with trigger phrase lists, which is exactly what the model
 * matches on — so it cannot be shortened at the source. Clamp it to one line here and let
 * the reader open it, and keep the name on one line so the checkbox column stays aligned.
 */
function SkillRow({
  skill,
  checked,
  onToggle,
}: {
  skill: Skill;
  checked: boolean;
  onToggle: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const inputId = `skill-${skill.id}`;

  return (
    <div className="flex items-start gap-2 text-sm">
      <input id={inputId} type="checkbox" className="mt-1 shrink-0" checked={checked} onChange={onToggle} />
      <label htmlFor={inputId} className="shrink-0 cursor-pointer whitespace-nowrap font-medium">
        {skill.name}
      </label>
      {skill.description && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          title={expanded ? 'Collapse description' : 'Show the full description'}
          className={`min-w-0 flex-1 cursor-pointer text-left text-xs text-(--color-text-muted) hover:text-(--color-text) ${
            expanded ? 'whitespace-pre-wrap break-words' : 'truncate'
          }`}
        >
          — {skill.description}
        </button>
      )}
    </div>
  );
}

/**
 * Which connectors this bot may use. Assignment is the permission: a connector the bot is not
 * given simply is not mounted for its turns, so its tools do not exist as far as the model is
 * concerned. Managing the connectors themselves happens on the Connectors screen.
 */
function ConnectorsEditor({ botId }: { botId: string }) {
  const [connectors, setConnectors] = useState<ApiConnector[]>([]);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.connectors.list().then(setConnectors);
  }, []);

  // Same trap as the skills panel: without seeding from what the bot already has, the first
  // "Save connectors" writes an empty list and quietly revokes everything.
  useEffect(() => {
    api.bots.connectors.get(botId).then((assigned) => setEnabled(new Set(assigned.map((c) => c.id))));
  }, [botId]);

  function toggle(id: string) {
    setEnabled((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSaved(false);
  }

  async function save() {
    await api.bots.connectors.set(botId, Array.from(enabled));
    setSaved(true);
  }

  if (connectors.length === 0) {
    return <p className="text-xs text-(--color-text-muted)">No connectors yet. Add one on the Connectors screen.</p>;
  }

  return (
    <div className="space-y-2">
      {connectors.map((c) => (
        <label key={c.id} className="flex items-start gap-2 text-xs">
          <input type="checkbox" checked={enabled.has(c.id)} onChange={() => toggle(c.id)} className="mt-0.5" />
          <span className="min-w-0">
            <span className="font-medium">{c.name}</span>
            <span className="ml-1 text-(--color-text-muted)">{String(c.config.transport)}</span>
            {!c.enabled && <span className="ml-1 text-(--color-text-muted)">(disabled)</span>}
            {c.missingSecrets.length > 0 && (
              <span className="ml-1 text-(--color-amber)">missing secret: {c.missingSecrets.join(', ')}</span>
            )}
            {c.description && <span className="block truncate text-(--color-text-muted)" title={c.description}>{c.description}</span>}
          </span>
        </label>
      ))}
      <button type="button" onClick={save} className="rounded bg-(--color-accent) px-3 py-1.5 text-xs font-medium text-(--color-accent-fg)">
        Save connectors
      </button>
      {saved && <span className="ml-2 text-xs text-(--color-green)">Saved</span>}
    </div>
  );
}

function SkillsEditor({ botId }: { botId: string }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.skills.list().then(setSkills);
  }, []);

  // Seed the checkboxes from what this bot already has. Without this the panel
  // renders every skill unchecked and "Save skills" persists an empty list,
  // silently unassigning them.
  useEffect(() => {
    api.bots.skills.get(botId).then((assigned) => setEnabled(new Set(assigned.map((s) => s.id))));
  }, [botId]);

  function toggle(id: string) {
    setEnabled((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSaved(false);
  }

  async function save() {
    await api.bots.skills.set(botId, Array.from(enabled));
    setSaved(true);
  }

  if (skills.length === 0) {
    return <p className="text-xs text-(--color-text-muted)">No skills taught yet.</p>;
  }

  return (
    <div className="space-y-2">
      {skills.map((s) => (
        <SkillRow key={s.id} skill={s} checked={enabled.has(s.id)} onToggle={() => toggle(s.id)} />
      ))}
      <button type="button" onClick={save} className="rounded bg-(--color-accent) px-3 py-1.5 text-xs font-medium text-(--color-accent-fg)">
        Save skills
      </button>
      {saved && <span className="ml-2 text-xs text-(--color-green)">Saved</span>}
    </div>
  );
}

export function BotSettings({ bot, onClose, onUpdated, onDuplicated, onDeleted }: BotSettingsProps) {
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  async function togglePinned() {
    onUpdated(await api.bots.update(bot.id, { pinned: !bot.pinned }));
  }
  async function toggleHidden() {
    onUpdated(await api.bots.update(bot.id, { hidden: !bot.hidden }));
  }
  async function toggleNotifications() {
    onUpdated(await api.bots.update(bot.id, { notifications: !bot.notifications }));
  }
  async function duplicate() {
    onDuplicated(await api.bots.duplicate(bot.id));
  }
  async function confirmDelete() {
    await api.bots.remove(bot.id);
    onDeleted(bot.id);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{bot.name} settings</h2>
        <button type="button" onClick={onClose} className="text-sm text-(--color-text-muted) hover:text-(--color-text)">
          Close
        </button>
      </div>

      <section className="mb-6">
        <ProfileEditor bot={bot} onUpdated={onUpdated} />
      </section>

      <section className="mb-6 flex flex-wrap gap-2 border-t border-(--color-border) pt-4">
        <button type="button" onClick={togglePinned} className="rounded border border-(--color-border) px-3 py-1.5 text-xs hover:bg-(--color-bg-hover)">
          {bot.pinned ? 'Unpin' : 'Pin'}
        </button>
        <button type="button" onClick={toggleHidden} className="rounded border border-(--color-border) px-3 py-1.5 text-xs hover:bg-(--color-bg-hover)">
          {bot.hidden ? 'Unhide' : 'Hide'}
        </button>
        <button type="button" onClick={toggleNotifications} className="rounded border border-(--color-border) px-3 py-1.5 text-xs hover:bg-(--color-bg-hover)">
          {bot.notifications ? 'Mute notifications' : 'Unmute notifications'}
        </button>
        <button type="button" onClick={duplicate} className="rounded border border-(--color-border) px-3 py-1.5 text-xs hover:bg-(--color-bg-hover)">
          Duplicate
        </button>
        <button
          type="button"
          onClick={() => setDeleteConfirm(true)}
          className="rounded border border-(--color-red)/50 px-3 py-1.5 text-xs text-(--color-red) hover:bg-(--color-red)/10"
        >
          Delete
        </button>
      </section>

      {deleteConfirm && (
        <div className="mb-6 rounded border border-(--color-red)/50 bg-(--color-red)/10 p-3 text-sm">
          <p className="text-(--color-red)">
            Delete {bot.name}? This removes it from your roster and conversation history, but its workspace files
            and any browser logins it used survive deletion.
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={confirmDelete} className="rounded bg-(--color-red) px-3 py-1.5 text-xs font-medium text-white">
              Delete permanently
            </button>
            <button type="button" onClick={() => setDeleteConfirm(false)} className="rounded px-3 py-1.5 text-xs text-(--color-text-muted)">
              Cancel
            </button>
          </div>
        </div>
      )}

      <section className="mb-6 border-t border-(--color-border) pt-4">
        <h3 className="mb-2 text-sm font-semibold">Memory</h3>
        <MemoryEditor botId={bot.id} />
      </section>

      <section className="mb-6 border-t border-(--color-border) pt-4">
        <h3 className="mb-2 text-sm font-semibold">Skills</h3>
        <SkillsEditor botId={bot.id} />
      </section>

      <section className="mb-6 border-t border-(--color-border) pt-4">
        <h3 className="mb-2 text-sm font-semibold">Connectors</h3>
        <ConnectorsEditor botId={bot.id} />
      </section>

      <section className="border-t border-(--color-border) pt-4">
        <h3 className="mb-2 text-sm font-semibold">Routines</h3>
        <RoutinesPanel botId={bot.id} />
      </section>
    </div>
  );
}
