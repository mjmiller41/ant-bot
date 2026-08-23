import { useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { RosterEntry, Skill, Attachment } from '@antbot/shared';
import { LIMITS } from '@antbot/shared';
import { api } from '../api/client.js';

export interface ComposerProps {
  onSend: (contentMd: string, attachmentIds: string[]) => void;
  bots: RosterEntry[];
  skills: Skill[];
  running?: boolean;
  onStop?: () => void;
  uploadFile?: (file: File) => Promise<Attachment>;
}

const MAX_ATTACHMENTS = LIMITS.MAX_ATTACHMENTS_PER_MESSAGE;

function currentToken(text: string, cursor: number): { prefix: '@' | '/'; query: string; start: number } | null {
  const upTo = text.slice(0, cursor);
  const match = /(^|\s)([@/])([\w-]*)$/.exec(upTo);
  if (!match) return null;
  const prefix = match[2] as '@' | '/';
  if (prefix === '/' && upTo.trim() !== `/${match[3]}`) return null; // slash commands only at message start
  return { prefix, query: match[3], start: cursor - match[3].length - 1 };
}

export function Composer({ onSend, bots, skills, running, onStop, uploadFile }: ComposerProps) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [token, setToken] = useState<{ prefix: '@' | '/'; query: string; start: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentsLenRef = useRef(0);
  attachmentsLenRef.current = attachments.length;

  const doUpload = useMemo(() => uploadFile ?? ((file: File) => api.attachments.upload(file)), [uploadFile]);

  const mentionOptions = useMemo(() => {
    if (!token || token.prefix !== '@') return [];
    const q = token.query.toLowerCase();
    return bots.filter((b) => b.bot.name.toLowerCase().includes(q) || b.bot.slug.toLowerCase().includes(q)).slice(0, 8);
  }, [token, bots]);

  const skillOptions = useMemo(() => {
    if (!token || token.prefix !== '/') return [];
    const q = token.query.toLowerCase();
    return skills.filter((s) => s.slug.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)).slice(0, 8);
  }, [token, skills]);

  function addFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    const room = Math.max(0, MAX_ATTACHMENTS - attachmentsLenRef.current);
    const toAdd = files.slice(0, room);
    attachmentsLenRef.current = Math.min(MAX_ATTACHMENTS, attachmentsLenRef.current + toAdd.length);
    for (const file of toAdd) {
      void doUpload(file)
        .then((att) => {
          setAttachments((cur) => (cur.length >= MAX_ATTACHMENTS ? cur : [...cur, att]));
        })
        .catch(() => {
          attachmentsLenRef.current = Math.max(0, attachmentsLenRef.current - 1);
        });
    }
  }

  function removeAttachment(id: string) {
    setAttachments((cur) => cur.filter((a) => a.id !== id));
  }

  function send() {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed, attachments.map((a) => a.id));
    setText('');
    setAttachments([]);
    setToken(null);
  }

  function handleChange(value: string, cursor: number) {
    setText(value);
    setToken(currentToken(value, cursor));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape') {
      setToken(null);
    }
  }

  function applyToken(value: string) {
    if (!token) return;
    const el = textareaRef.current;
    const cursor = el ? el.selectionStart : text.length;
    const before = text.slice(0, token.start);
    const after = text.slice(cursor);
    const insertion = token.prefix === '@' ? `@${value} ` : `/${value} `;
    const next = `${before}${insertion}${after}`;
    setText(next);
    setToken(null);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = before.length + insertion.length;
      el?.setSelectionRange(pos, pos);
    });
  }

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageFiles = items
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (imageFiles.length > 0) {
      e.preventDefault();
      addFiles(imageFiles);
    }
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  }

  return (
    <div
      className="shrink-0 border-t border-(--color-border) bg-(--color-bg-elevated) p-3"
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((att) => (
            <span
              key={att.id}
              data-testid="attachment-chip"
              className="flex items-center gap-1.5 rounded-full border border-(--color-border) bg-(--color-bg) px-2.5 py-1 text-xs"
            >
              {att.name}
              <button
                type="button"
                aria-label={`Remove ${att.name}`}
                className="text-(--color-text-muted) hover:text-(--color-red)"
                onClick={() => removeAttachment(att.id)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {token && (mentionOptions.length > 0 || skillOptions.length > 0) && (
        <div className="mb-2 max-h-40 overflow-auto rounded border border-(--color-border) bg-(--color-bg) text-sm shadow-lg">
          {token.prefix === '@'
            ? mentionOptions.map((b) => (
                <button
                  type="button"
                  key={b.bot.id}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-(--color-bg-hover)"
                  onClick={() => applyToken(b.bot.slug)}
                >
                  <span>{b.bot.avatarEmoji}</span>
                  <span>{b.bot.name}</span>
                </button>
              ))
            : skillOptions.map((s) => (
                <button
                  type="button"
                  key={s.id}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-(--color-bg-hover)"
                  onClick={() => applyToken(s.slug)}
                >
                  <span className="shrink-0 font-mono text-(--color-text-muted)">/{s.slug}</span>
                  <span className="min-w-0 truncate text-(--color-text-muted)" title={s.description}>
                    {s.description}
                  </span>
                </button>
              ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <button
          type="button"
          aria-label="Attach files"
          className="shrink-0 rounded border border-(--color-border) px-2.5 py-2 text-sm hover:bg-(--color-bg-hover)"
          onClick={() => fileInputRef.current?.click()}
        >
          +
        </button>
        <input
          ref={fileInputRef}
          data-testid="attachment-input"
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <textarea
          ref={textareaRef}
          value={text}
          rows={1}
          placeholder="Message… (@ to mention, / for a skill)"
          className="max-h-40 min-h-[38px] flex-1 resize-none rounded border border-(--color-border) bg-(--color-bg) px-3 py-2 text-sm outline-none focus:border-(--color-accent)"
          onChange={(e) => handleChange(e.target.value, e.target.selectionStart)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />
        {running && (
          <button
            type="button"
            onClick={onStop}
            className="shrink-0 rounded border border-(--color-red) px-3 py-2 text-sm font-medium text-(--color-red) hover:bg-(--color-red)/10"
          >
            Stop
          </button>
        )}
        <button
          type="button"
          onClick={send}
          disabled={!text.trim()}
          className="shrink-0 rounded bg-(--color-accent) px-3 py-2 text-sm font-medium text-(--color-accent-fg) disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}
