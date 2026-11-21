// Real Docker, opt-in: BUMPPROOF_DOCKER=1. Builds the fixture app at a good base and a deliberately broken head.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCheck } from '../src/check.ts';
import { loadConfig } from '../src/config.ts';
import { freeBytesOf } from '../src/doctor.ts';
import { run } from '../src/proc.ts';
import { httpStatus, inspectFacts, portFree } from '../src/sandbox.ts';
import { makeFixtureRepo } from './support/fixture-repo.ts';

const enabled = process.env.BUMPPROOF_DOCKER === '1';

test('real Docker: D7 flags applied, failed build detected, nothing left behind', { skip: !enabled && 'set BUMPPROOF_DOCKER=1', timeout: 600000 }, async () => {
  const cfg = loadConfig('/nonexistent');
  const repo = makeFixtureRepo();
  let facts: Awaited<ReturnType<typeof inspectFacts>>;
  const rec = await runCheck(
    { cfg, run, freeBytes: freeBytesOf, probe: httpStatus, isPortFree: portFree, now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
    { repo: repo.dir, base: 'base', head: 'head-broken', dir: 'app', runId: `it-${process.pid}`,
      onReady: async () => {
        facts = await inspectFacts(run, `${cfg.sandbox.container_prefix}-it-${process.pid}-base`);
        assert.equal(await httpStatus(`http://127.0.0.1:${cfg.port}/`), 200);
      } },
  );
  assert.equal(rec.outcome, 'head_build_failed');
  assert.equal(rec.sides[1]?.failed_at, 'build');
  assert.ok(rec.sides[1]?.log_tail.some((l) => l.includes('broken on purpose')));
  assert.deepEqual(facts!.cap_drop, ['ALL']);
  assert.ok(facts!.security_opt.includes('no-new-privileges'));
  assert.equal(facts!.nano_cpus, cfg.sandbox.cpus * 1e9);
  assert.equal(facts!.pids_limit, cfg.sandbox.pids_limit);
  assert.deepEqual(facts!.ports, [`127.0.0.1:${cfg.port}->${cfg.port}/tcp`]);
  assert.notEqual(facts!.user, '');
  assert.notEqual(facts!.user, 'root');
  const left = await run('docker', ['ps', '--all', '--quiet', '--filter', `label=${cfg.sandbox.label}`]);
  assert.equal(left.stdout.trim(), '');
  assert.equal(await portFree(cfg.port), true);
});
