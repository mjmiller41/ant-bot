import { useState } from 'react';
import type { CreateBotRequest, ModelTier } from '@antbot/shared';
import { EMOJI_CHOICES } from './emoji.js';

export interface NewBotDialogProps {
  onCreate: (body: CreateBotRequest) => void;
  onClose: () => void;
  busy?: boolean;
  error?: string | null;
}

export function NewBotDialog({ onCreate, onClose, busy, error }: NewBotDialogProps) {
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [avatarEmoji, setAvatarEmoji] = useState('🤖');
  const [modelTier, setModelTier] = useState<ModelTier>('sonnet');

  function submit() {
    if (!name.trim()) return;
    onCreate({ name: name.trim(), title: title.trim(), description: description.trim(), avatarEmoji, modelTier });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-lg border border-(--color-border) bg-(--color-bg-elevated) p-5 shadow-xl">
        <h2 className="mb-4 text-base font-semibold">New bot</h2>

        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="grid grid-cols-8 gap-1 rounded border border-(--color-border) p-1.5">
              {EMOJI_CHOICES.slice(0, 16).map((em) => (
                <button
                  key={em}
                  type="button"
                  aria-pressed={avatarEmoji === em}
                  onClick={() => setAvatarEmoji(em)}
                  className={`rounded p-1 text-lg ${avatarEmoji === em ? 'bg-(--color-accent)/25' : 'hover:bg-(--color-bg-hover)'}`}
                >
                  {em}
                </button>
              ))}
            </div>
          </div>

          <label className="block text-xs">
            <span className="mb-1 block text-(--color-text-muted)">Name</span>
            <input
              autoFocus
              className="w-full rounded border border-(--color-border) bg-(--color-bg) px-2 py-1.5 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Scout"
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block text-(--color-text-muted)">Title</span>
            <input
              className="w-full rounded border border-(--color-border) bg-(--color-bg) px-2 py-1.5 text-sm"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Research assistant"
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block text-(--color-text-muted)">Description</span>
            <textarea
              className="w-full rounded border border-(--color-border) bg-(--color-bg) px-2 py-1.5 text-sm"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What should this bot do?"
            />
          </label>

          <div>
            <span className="mb-1 block text-xs text-(--color-text-muted)">Model tier</span>
            <div className="inline-flex rounded border border-(--color-border) p-0.5">
              {(['sonnet', 'opus'] as const).map((tier) => (
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

          <p className="rounded border border-(--color-amber)/40 bg-(--color-amber)/10 p-2 text-xs text-(--color-amber)">
            Bots share one computer, workspace, browser profile and logins. Bots are not a security boundary.
          </p>

          {error && <p className="text-xs text-(--color-red)">{error}</p>}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-sm text-(--color-text-muted) hover:bg-(--color-bg-hover)">
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!name.trim() || busy}
            className="rounded bg-(--color-accent) px-3 py-1.5 text-sm font-medium text-(--color-accent-fg) disabled:opacity-40"
          >
            Create bot
          </button>
        </div>
      </div>
    </div>
  );
}
