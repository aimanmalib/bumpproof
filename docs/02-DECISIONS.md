# Decisions

Technical decisions taken while building Bumpproof, newest last. Each entry says what was chosen, why, and how to undo it.

## 1. TypeScript 5.9 with type stripping for tests (21 Nov 2026)

- **Chosen:** TypeScript 5.9.3 (`strict`, ESM, `erasableSyntaxOnly`). Source files import each other with `.ts` extensions;
  `rewriteRelativeImportExtensions` turns them into `.js` in `dist/`. Tests are `.ts` files run directly by `node --test`,
  which strips types natively on Node 22.18 and later. No test runner or loader is installed.
- **Why:** zero extra dev tools, and the tests exercise the same source the build compiles. TypeScript 7 (native) was available
  but is new; 5.9 is the line every editor and CI image already handles.
- **Users on Node 20:** they run the compiled `dist/`. CI builds and runs it on Node 20 in a separate job.
- **Undo:** switch tests to compiled output (`tsc` to a test folder, then `node --test` on it).

## 2. Runtime dependencies (21 Nov 2026)

- **Chosen:** `fflate` 0.8.3 (MIT), pinned exactly, to read Kane CLI evidence packs (zip files). Nothing else.
- **Why:** less to audit; the CLI runs on code pulled from other people's pull requests, so a small surface matters.

## 3. Values live in config, text lives in locales (21 Nov 2026)

- **Chosen:** every number, path, command name and list the code needs is in `config/defaults.json`; a project can override any
  key in `.bumpproof/config.json` (objects merge key by key, arrays replace). All text shown to people is in `locales/en.json`
  and `locales/ms.json`; English is the default, Malay with `--lang ms` or `BUMPPROOF_LANG=ms`. A test fails when the two files
  have different keys or different `{placeholders}`.
- **Undo:** `"enabled": false` in `.bumpproof/config.json` turns every command into a no-op.

## 4. `doctor` runs its checks in parallel and never prints identities (21 Nov 2026)

- **Chosen:** each check is a separate process with a timeout (`doctor.timeout_ms`), run side by side.
- **Why:** measured on the build host, Kane CLI 0.10.7 takes 16 to 20 s to answer even `--version`, with almost no CPU use.
  Run one after another, `doctor` took over a minute; in parallel it takes about 10 s.
- **Privacy:** `kane-cli whoami` and `gh auth status` print the account name or e-mail. `doctor` only reads their exit code and
  shows "logged in" or "not logged in".

## 5. Chrome for Kane CLI (21 Nov 2026)

- **Chosen:** look in this order: `KANE_CLI_CHROME_PATH`, config `kane.chrome_path`, a Chrome for Testing install under
  `kane.chrome_dir` (default `~/.local/share/bumpproof/chrome`, installed with
  `npx @puppeteer/browsers install chrome@stable --path ~/.local/share/bumpproof/chrome`), then the names Kane CLI itself
  looks for on `PATH`.
- **Why:** the build host has no system Chrome. Chrome for Testing is a pinned, unpacked build that needs no package manager.

## 6. The demo shop (21 Nov 2026)

- **Chosen:** `examples/shop`, a small Vite + React 18 shop in plain JavaScript, written during the hackathon against older major
  versions pinned exactly: `react-router-dom` 6.30, `@tanstack/react-query` 4.36, `date-fns` 2.30, `clsx` 1.2. Dependabot watches
  it daily (`.github/dependabot.yml`) and ignores React and Vite, so its pull requests are about the libraries the shop uses.
- **Why:** Bumpproof needs real Dependabot pull requests on a repository we own. The shop uses each library the way older apps do:
  relative links inside a splat route, `status === 'loading'` checks, default imports from `date-fns` subpaths. Whether a given
  upgrade really breaks the shop is checked with the real new version before any claim is made. Nothing in the shop reads a
  version number.
- **Text:** the shop is a test fixture, not a product, so it is English only. Its words are in `src/strings.json` and its prices,
  shipping rules and date format in `public/data/*.json`.
- **CI:** a separate job installs and builds the shop, the same check most projects run on a Dependabot pull request.
- **Undo:** delete `.github/dependabot.yml` to stop new pull requests; the shop folder can be removed without touching the CLI.

## 7. Verdict rules are code, and the edge cases are written down (21 Nov 2026)

- **Chosen:** `src/compare.ts` maps Kane CLI exit codes to an outcome per journey, then to one verdict per pull request.
  Exit code first: 0 pass, 1 fail, anything else is inconclusive and is retried once (`compare.inconclusive_retries`).
  A pass with an adaptive heal event is "UI moved, still works", not "same".
- **Edge cases decided here:**
  - A journey that does not pass on the base branch is left out and reported. It can never count against the pull request.
  - `check` without `fix` reports a regression or a failed build as **broken**. **Fixed** needs a fixer run after which every
    journey passes again.
  - If the base branch does not build, the verdict is **could not run**, even if a fix was attempted.
  - New console errors and new failed requests (4xx/5xx) on the head are warnings. They become failures only when
    `compare.console_errors_fail` or `compare.network_errors_fail` is `true`.
- **Undo:** the rules are one pure function each (`compareJourney`, `prVerdict`) with a test per branch.

## 8. Reading Kane CLI output without trusting its shape too much (21 Nov 2026)

- **Chosen:** `src/kane.ts` reads the JSON lines Kane CLI prints, one event per line. Lines that are not JSON are counted, not fatal. Unknown event types
  are ignored. The event names used (`stream_start`, `test_md_step_start`, `test_md_step_end`, `test_md_adaptive_heal`,
  `test_md_bug_verdict`, `run_end`, `test_md_done`) were read from the installed Kane CLI 0.10.7.
- **Credits:** an agent `run` reports `credits_consumed` on its `run_end`. For `testmd`, the sum of the per-step `run_end`
  events is used, unless `test_md_done` carries its own total. The first recorded real run checks this, and the test
  fixtures named `recorded-*` will replace the `synthetic-*` ones where they differ.
- **Budget:** every run is added to `census/kredit.json`. Totals are recomputed from the entries on every read, and a run
  is refused once `kane.credit_hard_stop` (or, for the census, `kane.census_budget`) is reached.

## 9. What leaves an evidence pack (21 Nov 2026)

- **Chosen:** `src/evidence.ts` never copies a pack. It reads console errors, failed requests (path only, no query string)
  and screenshot names, then removes the keys in `publish.strip_keys` (who ran it, `test_url`, cookies, auth headers),
  replaces private Test Manager links (`publish.private_url_patterns`) and e-mail addresses outside
  `publish.email_allowlist`.
- **Publication scan:** a test walks `docs/` and `census/` and fails on any of: the value of `KANE_USERNAME`, any address in
  `BUMPPROOF_PRIVATE_EMAILS`, other e-mail addresses, private links, or identity keys. Findings show a masked hint, never
  the value. On a machine without those variables, the scan still checks e-mail, links and keys.
- **Undo:** add a domain to `publish.email_allowlist` or a key to `publish.strip_keys` in `.bumpproof/config.json`.

## 10. The Docker sandbox (21 Nov 2026)

- **Chosen:** `src/sandbox.ts` runs the app under test in `node:22-bookworm-slim`. One container per side runs install, build
  and serve in that order. The base goes first, then the head, on the same port (4173 by default). Flags: the host user's
  uid:gid (never root), `--cap-drop ALL`, `no-new-privileges`, 2 CPUs, 3 GB memory, 512 processes, and the port published on
  `127.0.0.1` only. The container gets a short list of environment variables from `sandbox.env`, never the host environment.
  Installs use the lockfile and `--ignore-scripts`.
- **What goes in:** `src/git.ts` exports the app folder at each commit with `git archive` into a temporary folder. The
  container sees that folder and nothing else: no `.git`, no history, no credentials.
- **Failed build:** the setup script prints a marker before each phase. When the container exits, the last marker says
  where it stopped (install, build or serve). A server that is up but does not answer HTTP in `sandbox.serve_timeout_s` also
  counts as a failed build. A full disk, a busy port or Docker refusing to start are reported as host problems, not as a
  failed build.
- **Serving:** Vite and Next.js apps are served with their own preview servers bound to `0.0.0.0`. Many apps' own
  `preview` scripts bind `127.0.0.1`, which cannot be reached through a published port. Other apps use their `start`,
  `serve` or `preview` script with `HOST` and `PORT` set. `app.serve` in `.bumpproof/config.json` overrides all of this.
- **Cleanup:** each container is removed with its volumes right after its side. Before a run, any container with the
  `bumpproof=1` label is removed. A run that was cut off may have left one, and it would hold the port. Nothing else
  is ever removed, and images are never pruned. A run is refused when less than `sandbox.min_free_gb` is free.
- **Measured:** the demo shop at `d54d329` against Dependabot's date-fns 4.4.0 branch: base up in 23 s (first run, image
  pulled), head in 14.5 s, both built. A fixture app whose head build throws gives "failed build" with the error in the log
  tail.
- **Undo:** `sandbox.image`, limits, timeouts and commands are all in `config/defaults.json`.
