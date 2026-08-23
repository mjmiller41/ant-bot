import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

interface Entry {
  name: string;
  path: string;
  dir: boolean;
  bytes: number;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
const TEXT_EXT = /\.(md|markdown|txt|json|ya?ml|csv|log|ts|tsx|js|jsx|py|sh|css|html)$/i;

function isHidden(name: string) {
  return name.startsWith('.');
}

function TreeNode({ entry, depth, showHidden, onOpenFile }: { entry: Entry; depth: number; showHidden: boolean; onOpenFile: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<Entry[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    if (!entry.dir) {
      onOpenFile(entry.path);
      return;
    }
    if (!open && children === null) {
      setLoading(true);
      const list = await api.workspace.tree(entry.path);
      setChildren(list);
      setLoading(false);
    }
    setOpen((v) => !v);
  }

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm hover:bg-(--color-bg-hover)"
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
      >
        <span className="w-3 shrink-0 text-(--color-text-faint)">{entry.dir ? (open ? '▾' : '▸') : ''}</span>
        <span className="shrink-0">{entry.dir ? '📁' : '📄'}</span>
        <span className="truncate">{entry.name}</span>
        {!entry.dir && <span className="ml-auto shrink-0 text-xs text-(--color-text-faint)">{entry.bytes}B</span>}
      </button>
      {open && (
        <div>
          {loading && <div style={{ paddingLeft: `${(depth + 1) * 14 + 6}px` }} className="py-1 text-xs text-(--color-text-faint)">Loading…</div>}
          {children
            ?.filter((c) => showHidden || !isHidden(c.name))
            .map((c) => (
              <TreeNode key={c.path} entry={c} depth={depth + 1} showHidden={showHidden} onOpenFile={onOpenFile} />
            ))}
        </div>
      )}
    </div>
  );
}

function FilePreview({ path, onClose }: { path: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const name = path.split('/').pop() ?? path;
  const isImage = IMAGE_EXT.test(name);
  const isText = TEXT_EXT.test(name);

  useEffect(() => {
    setText(null);
    if (isText) {
      fetch(api.workspace.fileUrl(path))
        .then((r) => r.text())
        .then(setText)
        .catch(() => setText('(failed to load preview)'));
    }
  }, [path, isText]);

  return (
    <div className="flex h-full flex-col border-l border-(--color-border)">
      <div className="flex items-center justify-between border-b border-(--color-border) p-2">
        <span className="truncate text-sm font-medium">{name}</span>
        <div className="flex items-center gap-2">
          <a href={api.workspace.fileUrl(path)} download={name} className="text-xs text-(--color-accent) hover:underline">
            Download
          </a>
          <button type="button" onClick={onClose} className="text-xs text-(--color-text-muted) hover:text-(--color-text)">
            Close
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {isImage && <img src={api.workspace.fileUrl(path)} alt={name} className="max-w-full" />}
        {isText && <pre className="whitespace-pre-wrap font-mono text-xs">{text ?? 'Loading…'}</pre>}
        {!isImage && !isText && <p className="text-sm text-(--color-text-muted)">No inline preview available — use Download.</p>}
      </div>
    </div>
  );
}

export function WorkspaceBrowser() {
  const [root, setRoot] = useState<Entry[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.workspace
      .tree('')
      .then(setRoot)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="flex h-full">
      <div className="flex w-80 shrink-0 flex-col border-r border-(--color-border)">
        <div className="flex items-center justify-between border-b border-(--color-border) p-2">
          <h2 className="text-sm font-semibold">Workspace</h2>
          <label className="flex items-center gap-1 text-xs text-(--color-text-muted)">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
            Hidden files
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {loading && <p className="p-2 text-xs text-(--color-text-muted)">Loading…</p>}
          {!loading && root.length === 0 && <p className="p-2 text-xs text-(--color-text-muted)">Workspace is empty.</p>}
          {root
            .filter((e) => showHidden || !isHidden(e.name))
            .map((e) => (
              <TreeNode key={e.path} entry={e} depth={0} showHidden={showHidden} onOpenFile={setPreviewPath} />
            ))}
        </div>
      </div>
      {previewPath && <div className="w-96 shrink-0"><FilePreview path={previewPath} onClose={() => setPreviewPath(null)} /></div>}
    </div>
  );
}
