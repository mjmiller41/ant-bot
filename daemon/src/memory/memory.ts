import fs from 'node:fs';
import path from 'node:path';

/** Per-bot memory lives as markdown on the shared computer: workspace/bots/<slug>/memory/*.md */
export function memoryDir(workspace: string, slug: string): string {
  return path.join(workspace, 'bots', slug, 'memory');
}

export function ensureMemoryDir(workspace: string, slug: string): string {
  const dir = memoryDir(workspace, slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface MemoryFile { name: string; content: string }

export function readMemory(workspace: string, slug: string): MemoryFile[] {
  const dir = memoryDir(workspace, slug);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((name) => ({ name, content: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

export function writeMemory(workspace: string, slug: string, name: string, content: string): void {
  const dir = ensureMemoryDir(workspace, slug);
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '-');
  fs.writeFileSync(path.join(dir, safe.endsWith('.md') ? safe : `${safe}.md`), content);
}

export function deleteMemory(workspace: string, slug: string, name: string): void {
  const f = path.join(memoryDir(workspace, slug), name.replace(/[^a-zA-Z0-9._-]/g, '-'));
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

export function renderMemoryBlock(files: MemoryFile[]): string {
  if (!files.length) return '';
  const body = files.map((f) => `### ${f.name}\n${f.content.trim()}`).join('\n\n');
  return `\n\n## Your memory\nStable preferences and facts you recorded earlier. Memory is a working\nnote, not an authoritative source — re-check the source system before any\nconsequential decision.\n\n${body}`;
}
