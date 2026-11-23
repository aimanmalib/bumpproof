// Temporary folders for tests. Every folder made here is removed when the test process exits,
// so a run of the suite leaves nothing behind in the system temp folder.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made: string[] = [];

function removeAll(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function tempDir(prefix: string): string {
  if (made.length === 0) process.once('exit', removeAll);
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
