// `bumpproof replay <docs/runs/<id>>`: plays a recorded run back in the terminal.
// Reads one local file. No Kane CLI, no credits, no network, so a judge can run it from a fresh clone.
import type { Translate } from './i18n.ts';
import { readRun, short, type RunReport } from './report/run.ts';
import { bumpList, duration, timelineText } from './report/words.ts';
import type { Paint } from './ui.ts';

export interface ReplayOptions {
  /** Recorded seconds per real second. 0 prints everything at once. */
  speed: number;
  /** Longest pause between two lines, in milliseconds, whatever the recorded gap. */
  maxGapMs: number;
  sleep: (ms: number) => Promise<void>;
  out: (line: string) => void;
}

export function headerLines(run: RunReport, t: Translate, p: Paint): string[] {
  const lines = [p.bold(t('replay.header', { id: run.run_id, date: run.started_at.slice(0, 16).replace('T', ' ') + 'Z' }))];
  if (run.synthetic) lines.push(p.fail(t('replay.synthetic')));
  if (run.source.repo && run.source.pr !== null) {
    lines.push(t('replay.source', { repo: run.source.repo, pr: run.source.pr, title: run.source.pr_title ?? '' }));
  }
  lines.push(p.dim(t('replay.refs', { base: run.base.ref, base_sha: short(run.base.sha), head: run.head.ref, head_sha: short(run.head.sha) })));
  lines.push(p.dim(t('comment.bumps', { list: bumpList(run, t('comment.none')) })), '');
  return lines;
}

export function stamp(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Waits between lines in proportion to the recorded gaps, capped by `maxGapMs`. Entries play in time order. */
export async function replay(run: RunReport, t: Translate, p: Paint, o: ReplayOptions): Promise<void> {
  for (const l of headerLines(run, t, p)) o.out(l);
  const entries = [...run.timeline].sort((a, b) => a.at_s - b.at_s);
  let last = 0;
  for (const e of entries) {
    if (o.speed > 0) {
      const wait = Math.min(o.maxGapMs, ((e.at_s - last) / o.speed) * 1000);
      if (wait > 0) await o.sleep(wait);
    }
    last = e.at_s;
    const paint = e.tone === 'ok' ? p.ok : e.tone === 'fail' ? p.fail : e.tone === 'warn' ? p.bold : (s: string) => s;
    o.out(`${p.dim(stamp(e.at_s))}  ${paint(timelineText(t, e))}`);
  }
  o.out('');
  const v = run.verdict.verdict;
  const line = t('replay.done', { verdict: t(`verdict.${v}`), reason: t(`reason.${run.verdict.reason}`) });
  o.out(v === 'safe' || v === 'fixed' ? p.ok(p.bold(line)) : p.fail(p.bold(line)));
  o.out(p.dim(t('replay.totals', { journeys: run.journeys.length, credits: run.credits_consumed, time: duration(t, run.duration_s) })));
}

export { readRun };
