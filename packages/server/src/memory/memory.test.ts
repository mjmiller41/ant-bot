import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { memoryDir, ensureMemoryDir, readMemory, writeMemory, deleteMemory, renderMemoryBlock } from './memory.js';

describe('memory', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'antbot-memory-'));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('memoryDir / ensureMemoryDir build and create the expected path', () => {
    const dir = memoryDir(workspace, 'bot1');
    expect(dir).toBe(path.join(workspace, 'bots', 'bot1', 'memory'));
    expect(fs.existsSync(dir)).toBe(false);
    const ensured = ensureMemoryDir(workspace, 'bot1');
    expect(ensured).toBe(dir);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('write -> read round-trips content', () => {
    writeMemory(workspace, 'bot1', 'notes', '# Hello');
    const files = readMemory(workspace, 'bot1');
    expect(files.length).toBe(1);
    expect(files[0].name).toBe('notes.md');
    expect(files[0].content).toBe('# Hello');
  });

  it('only returns .md files', () => {
    ensureMemoryDir(workspace, 'bot1');
    writeMemory(workspace, 'bot1', 'keep', 'x');
    fs.writeFileSync(path.join(memoryDir(workspace, 'bot1'), 'ignore.txt'), 'not markdown');
    const files = readMemory(workspace, 'bot1');
    expect(files.map((f) => f.name)).toEqual(['keep.md']);
  });

  it('results are sorted by filename', () => {
    const dir = ensureMemoryDir(workspace, 'bot1');
    fs.writeFileSync(path.join(dir, 'c.md'), 'c');
    fs.writeFileSync(path.join(dir, 'a.md'), 'a');
    fs.writeFileSync(path.join(dir, 'b.md'), 'b');
    const files = readMemory(workspace, 'bot1');
    expect(files.map((f) => f.name)).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('sanitizes path-traversal filenames so writes stay inside the memory dir', () => {
    writeMemory(workspace, 'bot1', '../../etc/passwd', 'pwned');
    const dir = memoryDir(workspace, 'bot1');
    const entries = fs.readdirSync(dir);
    expect(entries.length).toBe(1);
    // sanitization strips path separators (the only thing that could escape the dir);
    // literal dots are harmless once slashes are gone.
    expect(entries[0]).not.toContain('/');
    expect(entries[0]).not.toContain('\\');
    // must not have escaped the workspace root
    expect(fs.existsSync(path.join(workspace, '..', 'etc', 'passwd'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, entries[0]), 'utf8')).toBe('pwned');
  });

  it('sanitizes nested-path filenames like a/b so no subdirectory is created', () => {
    writeMemory(workspace, 'bot1', 'a/b', 'x');
    const dir = memoryDir(workspace, 'bot1');
    expect(fs.existsSync(path.join(dir, 'a'))).toBe(false);
    const entries = fs.readdirSync(dir);
    expect(entries.length).toBe(1);
    expect(entries[0].endsWith('.md')).toBe(true);
    expect(fs.statSync(path.join(dir, entries[0])).isFile()).toBe(true);
  });

  it('appends .md when missing and does not double it when present', () => {
    writeMemory(workspace, 'bot1', 'plain', 'a');
    expect(fs.existsSync(path.join(memoryDir(workspace, 'bot1'), 'plain.md'))).toBe(true);

    writeMemory(workspace, 'bot1', 'already.md', 'b');
    expect(fs.existsSync(path.join(memoryDir(workspace, 'bot1'), 'already.md'))).toBe(true);
    expect(fs.existsSync(path.join(memoryDir(workspace, 'bot1'), 'already.md.md'))).toBe(false);
  });

  it('deleteMemory removes an existing file and is a no-op for a missing one', () => {
    writeMemory(workspace, 'bot1', 'temp', 'x');
    expect(fs.existsSync(path.join(memoryDir(workspace, 'bot1'), 'temp.md'))).toBe(true);
    deleteMemory(workspace, 'bot1', 'temp.md');
    expect(fs.existsSync(path.join(memoryDir(workspace, 'bot1'), 'temp.md'))).toBe(false);
    expect(() => deleteMemory(workspace, 'bot1', 'nonexistent.md')).not.toThrow();
  });

  it('renderMemoryBlock([]) returns an empty string', () => {
    expect(renderMemoryBlock([])).toBe('');
  });

  it('renderMemoryBlock renders a heading and file content for non-empty input', () => {
    const block = renderMemoryBlock([{ name: 'a.md', content: 'hello there' }]);
    expect(block).toContain('## Your memory');
    expect(block).toContain('a.md');
    expect(block).toContain('hello there');
  });

  it('readMemory on a nonexistent dir returns [] rather than throwing', () => {
    expect(() => readMemory(workspace, 'never-created')).not.toThrow();
    expect(readMemory(workspace, 'never-created')).toEqual([]);
  });
});
