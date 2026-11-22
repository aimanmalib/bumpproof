// Adds Kane CLI step screenshots to a run recorded before `check` kept them (runs from 22 Nov 2026 and earlier).
// It reads the evidence packs on the machine that ran the journeys and writes only the publishable screenshots:
//   node scripts/add-shots.ts docs/runs/<id> <journey>:<side>=<file.evidence> ...
// The same code as `check` picks the step (collectShots) and the same publication scan guards the output.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRunJson } from '../src/check-cli.ts';
import { ROOT, loadConfig } from '../src/config.ts';
import { readPack } from '../src/evidence.ts';
import { parseRun } from '../src/report/run.ts';
import { collectShots, type Pack, type Side } from '../src/shots.ts';

const [dir, ...pairs] = process.argv.slice(2);
if (!dir || pairs.length === 0) {
  console.error('usage: node scripts/add-shots.ts docs/runs/<id> <journey>:<side>=<file.evidence> ...');
  process.exit(2);
}
const packs = new Map<string, Pack>();
for (const p of pairs) {
  const m = /^([\w-]+):(base|head|after_fix)=(.+)$/.exec(p);
  if (!m) { console.error(`not <journey>:<side>=<file>: ${p}`); process.exit(2); }
  packs.set(`${m[1]}:${m[2] as Side}`, readPack(readFileSync(m[3]!)));
}
const cfg = loadConfig(ROOT);
const rawText = readFileSync(join(dir, 'run.json'), 'utf8');
const raw = JSON.parse(rawText) as Record<string, unknown>;
const report = parseRun(raw);
const { shots, files } = collectShots(report, (name, side) => packs.get(`${name}:${side}`) ?? null, cfg.evidence.image_exts);
// Write through the scan into a scratch folder first; copy the images and the new run.json only when it is clean.
raw.shots = shots;
const scratch = mkdtempSync(join(tmpdir(), 'bumpproof-add-shots-'));
const problems = writeRunJson(scratch, { ...report, shots }, cfg, process.env, '', files);
rmSync(scratch, { recursive: true, force: true });
if (problems.length > 0) { console.error(problems.join('\n')); process.exit(1); }
mkdirSync(join(dir, 'shots'), { recursive: true });
for (const f of files) writeFileSync(join(dir, f.file), f.bytes);
writeFileSync(join(dir, 'run.json'), `${JSON.stringify(raw, null, 2)}\n`);
for (const f of files) console.log(`${f.file} ${f.bytes.length} bytes`);
