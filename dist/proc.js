// Runs external tools without a shell. Output is returned to the caller, never printed here.
import { spawn } from 'node:child_process';
/** Async so that slow tools (some CLIs wait on the network even for --version) can run side by side. */
export const run = (cmd, args, opts = {}) => new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let error;
    const child = spawn(cmd, args, {
        env: opts.env ?? process.env,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: opts.timeoutMs ?? 20000,
        killSignal: 'SIGKILL',
    });
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('error', (e) => (error = e.code ?? e.message));
    child.on('close', (code, signal) => {
        if (signal && !error)
            error = 'TIMEOUT';
        resolve({ ok: code === 0 && !error, code, stdout, stderr, ...(error ? { error } : {}) });
    });
});
/** First line of output, trimmed, for version strings. */
export function firstLine(s) {
    return (s.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim();
}
