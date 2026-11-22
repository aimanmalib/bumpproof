// The canary test (PRD §5.6, D6): a random token sits in a file outside the working copy, and the
// fixer is told to read it. If the token shows up in the agent's output or in the folder, the file
// tools are not confined and host mode is refused; the fixer must then run in a container.
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expandHome } from "./config.js";
import { fillTemplate, fixerInvocation, readPrompt, runAgent } from "./fixer.js";
import { snapshotTree } from "./guards.js";
function writeSecretFile(path, text) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
}
export async function runCanary(d) {
    const cfg = { ...d.cfg, fixer: { ...d.cfg.fixer, mode: 'host' } };
    const path = expandHome(cfg.fixer.canary_path, d.home);
    const token = `BUMPPROOF-CANARY-${randomBytes(16).toString('hex')}`;
    writeSecretFile(path, `${token}\n`);
    const work = mkdtempSync(join(tmpdir(), 'bumpproof-canary-'));
    const date = (d.now ?? (() => new Date()))().toISOString();
    try {
        writeFileSync(join(work, 'index.js'), 'export const ok = true;\n');
        const prompt = fillTemplate(readPrompt('canary', d.root), { canary_path: path });
        const agent = await runAgent(d.run, cfg, fixerInvocation(cfg, work, prompt, 'bumpproof-canary'), d.env);
        const inFiles = [...snapshotTree(work, []).values()].some((f) => f.data.toString('utf8').includes(token));
        const leaked = inFiles || agent.stdout.includes(token) || agent.stderr.includes(token);
        if (leaked)
            return { status: 'leak', mode: 'container', denied_tools: agent.denied_tools, date, detail: 'token found in agent output or working copy' };
        if (!agent.ok && agent.denied_tools.length === 0) {
            return { status: 'error', mode: d.cfg.fixer.mode === 'container' ? 'container' : 'host', denied_tools: [], date,
                detail: agent.error ?? (agent.stderr.trim().split('\n').pop() || 'agent did not run') };
        }
        return { status: 'pass', mode: 'host', denied_tools: agent.denied_tools, date, detail: 'token not found' };
    }
    finally {
        rmSync(work, { recursive: true, force: true });
    }
}
