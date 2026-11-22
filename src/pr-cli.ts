// The `pr` command: read the PR, clone, check its merge ref against the base tip (with journeys and, with --fix, the
// fixer), publish the run, then — only on our own repositories — push the verified fix and post the comment.
import { rmSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runJourneyCommand } from './check-cli.ts';
import type { JourneyCheckDeps } from './check-journeys.ts';
import { makeWorkDir, newRunId } from './check.ts';
import type { Config } from './config.ts';
import { cloneNoCheckout, GitError, shortSha } from './git.ts';
import type { Translate } from './i18n.ts';
import { BudgetError } from './journeys.ts';
import type { Fetcher } from './notes.ts';
import {
  appDirOf, canWrite, mergeLocally, fetchPrInfo, fillVars, parsePrRef, PrError, pushFix, slug, upsertComment,
} from './pr.ts';
import type { Runner } from './proc.ts';
import { renderComment } from './report/markdown.ts';
import { SandboxError } from './sandbox.ts';
import type { Paint } from './ui.ts';

export interface PrFlags { target: string | undefined; fix: boolean; comment: boolean; pushFix: boolean; publish: boolean; dir: string | undefined }

/** `pr` has boolean `--comment`, unlike `report --comment <run>`, so it parses its own arguments. */
export function parsePrArgs(argv: string[]): PrFlags {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: false,
    options: { fix: { type: 'boolean' }, comment: { type: 'boolean' }, 'push-fix': { type: 'boolean' },
      publish: { type: 'boolean' }, dir: { type: 'string' }, lang: { type: 'string' } },
  });
  return {
    target: positionals[1], fix: values.fix === true, comment: values.comment === true, pushFix: values['push-fix'] === true,
    publish: values.publish === true, dir: typeof values.dir === 'string' ? values.dir : undefined,
  };
}

export interface PrCommand {
  deps: JourneyCheckDeps;
  fetch: Fetcher;
  version: string;
  cwd: string;
  out: (s: string) => void;
  err: (s: string) => void;
}

export async function runPr(c: PrCommand, f: PrFlags, t: Translate, p: Paint): Promise<number> {
  const cfg: Config = c.deps.cfg;
  const run: Runner = c.deps.run;
  const ref = parsePrRef(f.target);
  if (!ref) {
    c.err(t('pr.need_ref'));
    return 2;
  }
  if ((f.comment || f.pushFix) && !canWrite(cfg, ref)) {
    c.err(t('pr.not_ours', { repo: slug(ref) }));
    return 2;
  }
  if (f.pushFix && !f.fix) {
    c.err(t('pr.push_needs_fix'));
    return 2;
  }
  const runId = newRunId();
  const scratch = makeWorkDir(cfg, `${runId}-pr`);
  try {
    const info = await fetchPrInfo(run, cfg, ref);
    if (info.state !== 'OPEN') {
      c.err(t('pr.not_open', { n: ref.number, state: info.state.toLowerCase() }));
      return 2;
    }
    const dir = appDirOf(info, cfg.app.dir, f.dir);
    c.out(t('pr.reading', { repo: slug(ref), n: ref.number, title: info.title, ci: t(`pr.ci_${info.ci}`), dir: dir || '.' }));
    const clone = `${scratch}/repo`;
    await cloneNoCheckout(run, `https://github.com/${slug(ref)}.git`, clone);
    const refs = await mergeLocally(run, clone, info);
    c.out(t('pr.refs', { base: shortSha(refs.base), base_ref: info.base_ref, head: shortSha(refs.head) }));
    const res = await runJourneyCommand({
      deps: c.deps, opts: { repo: clone, base: refs.base, head: refs.head, dir, runId },
      publish: f.publish, cwd: c.cwd, out: c.out, err: c.err,
      source: { repo: slug(ref), pr: ref.number, pr_url: info.url, pr_title: info.title, ci: info.ci },
      ...(f.fix ? { fix: { fetch: c.fetch } } : {}),
    }, t, p);
    let pushed: string | null = null;
    if (f.pushFix && res.report.verdict.verdict === 'fixed' && res.files.length > 0) {
      const b = res.report.bumps[0];
      const message = fillVars(cfg.pr.fix_commit_message, {
        name: b?.name ?? '?', from: b?.from ?? '?', to: b?.to ?? '?', run: res.report.run_id,
      });
      try {
        pushed = await pushFix(run, { clone, info, merge: refs.head, files: res.files, dir, message, scratch });
        c.out(t('pr.pushed', { sha: shortSha(pushed), branch: info.head_ref }));
      } catch (e) {
        if (!(e instanceof PrError || e instanceof GitError)) throw e;
        c.err(t('pr.push_refused', { detail: e.message }));
      }
    } else if (f.pushFix) {
      c.out(t('pr.nothing_to_push', { verdict: t(`verdict.${res.report.verdict.verdict}`) }));
    }
    if (f.comment) {
      const runUrl = res.published ? `${cfg.report.pages_url.replace(/\/?$/, '/')}runs/${res.report.run_id}/` : null;
      let body = renderComment(res.report, t, { version: c.version, runUrl, bugCode: cfg.kane.bug_result_code });
      if (pushed) body += `\n${t('pr.comment_pushed', { sha: pushed, short: shortSha(pushed), branch: info.head_ref })}\n`;
      const url = await upsertComment(run, cfg, ref, body, scratch);
      c.out(t('pr.commented', { url }));
    }
    return res.code;
  } catch (e) {
    let reason: string;
    if (e instanceof PrError) reason = t('pr.error', { detail: e.message });
    else if (e instanceof SandboxError) reason = t('check.refused', { reason: t(`sandbox.refused_${e.code}`, { detail: e.message }) });
    else if (e instanceof BudgetError) reason = t('check.budget', { detail: e.message });
    else if (e instanceof GitError) reason = t('check.git_error', { detail: e.message });
    else throw e;
    c.err(reason);
    return 2;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
