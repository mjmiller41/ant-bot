import fs from 'node:fs';
import path from 'node:path';

export interface PidFileData {
  pid: number;
  port: number;
  startedAt: number;
}

export function pidFilePath(dataDir: string): string {
  return path.join(dataDir, 'antbot.pid');
}

export function readPidFile(file: string): PidFileData | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw) as Partial<PidFileData>;
    if (typeof data.pid === 'number' && typeof data.port === 'number') {
      return { pid: data.pid, port: data.port, startedAt: data.startedAt ?? 0 };
    }
    return null;
  } catch {
    return null;
  }
}

export function writePidFile(file: string, data: PidFileData): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function removePidFile(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
