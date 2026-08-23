import { randomUUID } from 'node:crypto';
export const newId = (): string => randomUUID();
export const now = (): number => Date.now();
export function slugify(name: string, existing: Set<string> = new Set()): string {
  const base =
    name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'bot';
  let slug = base;
  let n = 2;
  while (existing.has(slug)) slug = `${base}-${n++}`;
  return slug;
}
