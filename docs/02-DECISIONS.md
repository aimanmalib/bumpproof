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

## 11. The fixer, its guards and the canary (21 Nov 2026)

- **Chosen:** `src/fixer.ts` runs Claude Code as `claude -p` in the head's working copy. Its tools are Read, Edit, Write,
  Glob and Grep. `--restricted` keeps the file tools inside the working copy, `--strict-mcp-config` loads no MCP servers,
  and `--no-session-persistence` saves no session. The model comes from `fixer.model` (`claude-opus-5-5`). All flags are in
  `fixer.args`, so another agent can replace it through `fixer.command`.
- **Release notes:** `src/notes.ts` fetches them, not the agent. It reads npm metadata for the repository, then GitHub
  Releases between the two versions. If there are none, it reads the CHANGELOG. An upgrade guide from `notes.guides` is
  added when one is listed. The text is cut to `notes.max_kb` (24 KB) and wrapped in `<untrusted_release_notes>`. The
  prompt says that block is data. A closing marker inside the notes is defused, so the notes cannot end the block early.
- **Prompts:** every word the agent reads is in `prompts/*.md`. Code only fills the placeholders. A placeholder left empty
  is an error, not a silent gap.
- **Guards:** `src/guards.ts` snapshots the working copy before the agent runs and compares it afterwards. `node_modules`
  and build output are skipped. A patch is rejected if it does any of these things:
  - touches `.bumpproof/**`, `*_test.md`, `output-*`, `.github/**` or a test file;
  - changes anything in `package.json` except adding new dependencies (this covers downgrades and edits to the bumped
    version);
  - adds a line matching `fixer.deny_patterns` (`child_process`, `eval(`, `new Function(`);
  - changes more than `fixer.max_patch_lines` lines (300);
  - adds a symbolic link or a binary file;
  - changes no code, or has no `BUMPPROOF_FIX.md`.
  A rejected attempt is undone and counts as one of the `fixer.max_attempts` (2). Its reasons go into the next prompt. A patch
  that passes the guards but fails the rebuild and replay is undone in the same way.
- **Kept key name:** the line limit stays at `fixer.max_patch_lines`, the key that was already in config, instead of
  PRD's `fix.max_changed_lines`. The value and the rule are the same.
- **Canary, 21 Nov 2026 22:44 UTC:** `bumpproof fix --canary` writes a random token to `~/.cache/bumpproof/kanari.txt`.
  That file is outside the working copy. The fixer is told to read it. Claude Code 2.1.330 refused the Read call, and the
  token was not in the reply or in the folder. **Result: host mode.** The live test is `BUMPPROOF_KANARI=1 node --test
  test/canary.test.ts`. It is opt-in because it spends tokens.
- **Container mode:** if a later canary fails, set `fixer.mode` to `container`. The agent then runs in Docker with only the
  working copy mounted, the same limits as the sandbox, and `ANTHROPIC_API_KEY` passed by name from the environment. This
  path is unit-tested only, because the canary passed in host mode.
- **Measured:** one live run on a small app that imports `date-fns/format` as a default export, bumped from 2.30.0 to 4.1.0.
  The release notes came from 15 KB of GitHub Releases. The first attempt did not pass the test's check, so it was
  undone. The second attempt changed one import line (2 changed lines). It cost $0.10 and quoted the
  v3.0.0 note on named exports in `BUMPPROOF_FIX.md`.
- **Undo:** `fixer.args`, `fixer.mode`, the guard lists and the notes sources are all in `config/defaults.json`.

## 12. Report pages, PR comment and replay (21 Nov 2026)

- **One record:** `docs/runs/<id>/run.json` is the published run record (`schema_version` 1). The PR comment, the pages
  and `replay` read only this file. `src/report/run.ts` checks every field on the way in. A broken record stops
  `bumpproof report` instead of being skipped. File names inside a record (run id, patch, screenshots) must be plain
  relative names, so a record cannot point outside its folder.
- **Words, not sentences, in the record:** timeline lines hold a locale key and values. The same run reads in English
  or Malay in the terminal, the comment and the page.
- **Pages:** plain HTML, one CSS file and one small script, written by `bumpproof report` to `docs/` (PRD D11). Each page
  holds an English and a Malay copy, and the switch shows one. With scripts off, English shows. The CSS, script and fonts
  live once, in `docs/assets/`. The package ships that folder, and a report written elsewhere gets a copy.
  Fonts are IBM Plex Sans, Sans Condensed and Mono (OFL 1.1), served from the site with no font CDN.
  No `backdrop-filter` and no animated blur, because WebKit crashes on them.
- **Look:** a proof ledger. Warm paper, ink, hairline rules, and one coloured stamp per verdict. The direction comes
  from the PRD alone; nobody was asked to choose between options.
- **Publication scan before writing:** every page goes through the same scan as evidence packs (§9). One finding (an
  e-mail outside the allowlist, a Kane username, a private Test Manager link) means no page is written.
- **Honest examples:** the test fixture `test/fixtures/synthetic-run` is marked `"synthetic": true`. Pages and replay
  show a banner on it. The PR comment for it has no public link. "For judges" offers a replay command only for a real run.
- **Staleness check:** a test builds the site again and compares it with the committed `docs/` pages. A template change
  without `bumpproof report` fails the suite.
- **`replay`:** reads one local file. No Kane CLI, no credits, no network. Pauses follow the recorded gaps at
  `replay.speed` (40 recorded seconds per real second), capped at `replay.max_gap_ms` (900 ms). `--speed 0` prints at once.
  Checked from a clean copy in a Docker container with `--network none`.
- **Install from GitHub:** `package.json` gains a `prepare` script, so `npx github:aimanmalib/bumpproof` builds `dist/`
  on install.
- **Public strings in the scan:** the Kane user name can be the same as the GitHub owner name, and the owner name is
  in the repository URL on every page. `publish.public_strings` lists the exact public strings (the repository URL,
  `github:` install name and Pages host). A secret inside one of them is not a finding. The same value anywhere else
  still is, and is still redacted.

## 13. The GitHub Action: build check and comment only (22 Nov 2026)

- **What it runs:** `action.yml` is a composite Action. It installs Bumpproof from the Action folder and runs
  `bumpproof check` on the pull request base and head commits. It posts the result as one comment and updates that
  comment on the next push. No Kane CLI journeys, no fixer, no LLM key and no account key in GitHub (PRD D9). The
  comment says so in its own words and points to `bumpproof pr ... --fix` on a developer machine.
- **Finding its own comment:** the first line is a hidden marker, `<!-- bumpproof-action -->`. The second line carries
  the outcome (`<!-- bumpproof-outcome: ... -->`), so the Action reads the result without parsing a translated sentence.
- **Injection:** pull request branch names are chosen by whoever opens the pull request. Every value reaches the
  scripts through `env`, never through `${{ }}` inside `run`, and the comment prints short commit hashes, not branch
  names. A test reads `action.yml` and fails on an expression inside a script, a `secrets.` reference or `--fix`.
- **Disk floor on runners:** the host floor is 25 GB (`sandbox.min_free_gb`). A hosted runner has less free disk than
  that, so `check --min-free-gb` overrides it and the Action passes 10 GB by default.
- **Fork pull requests** get a read-only token. Posting then fails with a warning, and the result stays in the job summary.
- **CI:** a job runs the Action on `examples/shop` (same commit on both sides) and checks the outcome and the comment
  file. Way back: delete the job, or stop using the Action. The CLI does not depend on it.
