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

## 14. Census candidates: search and fixed rules (22 Nov 2026)

- **One command, read only:** `bumpproof census --find` searches GitHub through `gh api` and writes
  `census/candidates.json`. It reads repository metadata, the pull request, its file list, `package.json` at the base
  and head commits, the app folder listing and any `.env.example`. Nothing from these repositories is run, and we open
  no issue, comment or pull request on them.
- **Search:** one query per bot and watched package (`census.watchlist`, 18 packages × 2 bots = 36 queries, cap 60):
  open pull requests by `app/dependabot` or `app/renovate`, created on or after `census.created_since`, whose title
  holds the bot's own phrase (`"bump vite from"`, `"update dependency vite"`). A first run that searched for the bare
  package name matched `react-i18next` for `react`: 8 of 40 repositories checked changed no watched package. Queries are spaced `census.search_gap_ms` apart. GitHub's secondary limit still hits every few
  queries, so a limit waits `census.rate_limit_wait_s` and retries once; a second limit stops the search and the file
  says so (`stopped`).
- **Order and cap:** one pull request per repository, newest first, then repository name. Our own repository is skipped.
  Repositories are checked in that order until `census.target_eligible` (20, the PRD's "at most 20 candidates")
  pass, or `census.max_evaluate` or the time box is reached. Every repository checked is listed with its reasons.
  The ones never reached are counted by why (`not_checked`: `enough`, `limit`, `timebox`) rather than listed, since
  nothing about them was looked at; the queries and their totals are in the file, so the search can be rerun. A first
  version listed them all, which made the file 420 KB, mostly names nobody had checked. The census run takes eligible
  repositories from the top.
- **Rules, in stages:** (1) license on the list, not archived, under 50 MB; (2) the pull request is still open and
  changes a `package.json` or lockfile (the app folder is that file's folder; the title's `in /dir` breaks ties);
  (3) the `package.json` diff changes a watched package (the diff is the truth, as in `bump.ts`); (4) Vite, Next.js,
  Create React App or Astro, a `build` script and a `start`/`serve`/`preview` script, and no `preinstall`,
  `postinstall` or `prepare` in the app's or the root `package.json`; (5) a lockfile in the app folder and no env
  example key that looks like a secret. A stage that finds reasons ends the check, which saves API calls; all reasons
  within that stage are kept.
- **Added rule, lockfile:** PRD §5.9 does not name it. The sandbox installs with `npm ci` / `--frozen-lockfile` and
  `--ignore-scripts` (D7), which cannot run without a lockfile, so a repository without one would only fail later as
  "cannot run". `census.require_lockfile` turns it off.
- **CI state** of each eligible pull request comes from the same rollup `gh pr view --json statusCheckRollup` reads
  (asked through GraphQL so every call shares one pacer): `green`, `red`, `pending` or `none`. H3 ("CI green but
  broken") needs it.
- **Publication:** `census/` is published. The file holds repository names, pull request titles and links, licenses,
  script names and watched bumps. It holds no author fields. The publication scan runs before writing; one finding
  means no file.

## 15. Browser journeys in check, and what the demo upgrades really break (22 Nov 2026)

- **Journeys:** three Kane CLI `test.md` files in `examples/shop/.bumpproof/journeys/` (browse, checkout, account).
  They were authored once on the base branch at `http://127.0.0.1:4173`. The `output-*` folders are Kane CLI's cached
  recordings and are committed, so later runs replay them. Authoring cost 214.4 credits for the three.
- **Order and copies:** `check` serves the base, runs every journey, stops it, then serves the head on the same port and
  runs only the journeys that passed on the base. Each side runs on its own copy of the journeys folder in a temporary
  folder, so a heal on the head never rewrites the committed recordings.
- **Credits:** the account balance is read before and after each run. The drop is what goes into `census/kredit.json`.
  The sum in the run stream is the fallback. Measured on the first authoring run: stream sum 49.7, balance drop 56.8.
- **Failure text:** a confirmed bug from Kane CLI (`test_md_bug_verdict`) is used as the remark. The `run_end` reason
  is a machine code such as `action_failed: click @ step 2`.
- **Kane CLI 0.10.7 stream:** healing is reported by `test_md_adaptive_heal` and by `test_md_summary.adaptive_heal`.
  Two sanitized real streams are test fixtures (`test/fixtures/recorded-20261122-*.ndjson`).
- **The Action passes `--build-only`.** CI has no Kane CLI login (D9).
- **Chrome:** Chrome for Testing 158.0.8127.36, headless, found in the Chrome folder from config. No fallback needed.

What the four real Dependabot pull requests did (first runs, 22 Nov, published under `docs/runs/`):

| Package | Planned break | What happened |
|---|---|---|
| `@tanstack/react-query` 4.36.1 → 5.108.0 | v5 renames the `loading` status to `pending`; `lib.jsx` waits on `status === 'loading'` | Broken. All three journeys fail on the head. Console: `Cannot read properties of undefined (reading 'categories')`. Kane CLI confirmed a bug (result code 740). |
| `react-router-dom` 6.30.1 → 7.18.6 | v7 resolves relative links inside the `account/*` splat route from the full path | Broken. The account journey fails at "Use the tabs again". Browse and checkout pass. |
| `date-fns` 2.30.0 → 4.4.0 | Default imports from `date-fns/format` etc. | **Did not break.** v3 and v4 still ship `export default` in each function file ("Fallback for modularized imports"). The run says safe, and that is the honest result. |
| `clsx` 1.2.1 → 2.1.1 | none (expected safe) | Safe. |

The date-fns break was planned and did not happen. It is not faked. A real build failure for the fixer demo has to come
from a different API change that really fails (PRD §5.8); that is decided in the slice that needs it.

## 16. The fix loop: check --fix (22 Nov 2026)

- **Command:** `bumpproof check --base <ref> --head <ref> --fix` (or `bumpproof fix --base … --head …`). The fixer runs only
  when the verdict is broken because a journey regressed or the head did not build.
- **Working copy:** a fresh export of the head. The fixer gets the failure, the bumped packages and the release notes.
  For a regression that is the first failed journey: its `test.md` text from the base, the failed step, Kane CLI's remark
  and new console or network errors. For a failed build it gets the last log lines.
- **Verify:** each patch that passes the guards (§11) is copied to a new folder and built in the sandbox. The sandbox
  writes `node_modules` into the folder it mounts, so it never gets the agent's own folder. Kane CLI then replays the
  journeys that failed first, then the others. It replays from the base's journeys and recordings. It stops at the
  first journey that does not pass. Only when every journey that passed on the base passes again is the verdict
  `fixed`. `compare.ts` still decides it.
- **Record:** `run.json` keeps the head results and adds the fix build, `after_fix` for each journey, the fix summary
  and `fix.patch` next to it. The publication scan reads both files before either is written.
- **Busy port:** the first live run lost its fix stage. Another program on this host held 127.0.0.1:4173 for a moment.
  `startApp` now waits up to `sandbox.port_wait_s` (600 s) before it refuses.
- **A real build failure for the demo:** the planned date-fns break did not happen (§15). The shop now imports `addDays`
  from `date-fns/esm/addDays`, the per-function ES module path date-fns 2 ships. Version 3 lists its import paths in
  `package.json` ("The files exports are now explicitly in the `package.json`", v3.0.0 notes) and has no `esm` folder.

Measured (22 Nov, Kane CLI 0.10.7, Claude Code with `claude-opus-5-5`, host mode):

| Bump | Head | Fix | Result |
|---|---|---|---|
| `@tanstack/react-query` 4.36.1 → 5.108.0 (Dependabot branch) | 3 of 3 journeys fail | 1 attempt, `src/lib.jsx` `status === 'loading'` → `'pending'`, 2 changed lines, $0.17, quotes the v5 guide | Fixed: 3 of 3 pass after the fix. 70.7 credits, 21 min. Published as `docs/runs/20261122-0333-17ad/`. |
| `date-fns` 2.30.0 → 4.4.0 (Dependabot's `package.json` and lockfile on a local branch from `main`) | Build fails: `Missing "./esm/addDays" specifier in "date-fns" package` | 1 attempt, named imports from `date-fns` in two files, 5 changed lines, $0.16 | Fixed: 3 of 3 pass. 3.9 credits, 14 min. Not published: its head commit exists only on this machine. |

The date-fns fix also changed the default imports, quoting the v3 note on named exports. v4 still has default exports
(§15), so that part was not needed. It still builds, and every journey passes.

## 17. The pr command on real pull requests (22 Nov 2026)

- **Command:** `bumpproof pr <owner>/<repo>#<n> [--fix] [--publish] [--comment] [--push-fix]`. It reads the pull
  request with `gh pr view`, clones the repository and runs the same check and fix loop as `check --fix`.
- **Merged locally, not GitHub's merge ref.** The first try used `refs/pull/<n>/merge`. Its first parent was a `main`
  from before the journeys were added, so the run found no journeys. GitHub updates that ref lazily. The command now
  fetches the base branch tip and the PR head, merges them with `git merge-tree`, and compares the base tip with that
  merge. A conflict is refused with a hint to rebase.
- **Write access is a list in config** (`pr.write_repos`). `--comment` and `--push-fix` are refused before any network
  call for other repositories. A census run is read-only by construction.
- **The fix is pushed as files, not as `fix.patch`.** `fix.patch` is a report diff with no hunk headers; `git apply`
  cannot use it. The push writes the fixed files' new text. Each file must have the same blob on the PR branch as on
  the merge the fix was verified on, so nothing the fix did not see is overwritten. The branch tip must still be the
  head that was tested. One new commit, a normal push, never a force push, never a merge.
- **One comment per pull request.** The body starts with `<!-- bumpproof-pr -->`; a later run edits that comment.
- PR #1 was behind `main`; a `@dependabot rebase` comment on it had Dependabot rebase it so its head carries the
  `date-fns/esm` import (§16). Its CI then went red.

Measured (22 Nov, Kane CLI 0.10.7, Claude Code with `claude-opus-5-5`, host mode):

| PR | Bump | CI | Verdict | Fix | Credits | Time |
|---|---|---|---|---|---|---|
| #4 | clsx 1.2.1 → 2.1.1 | green | safe, 3 of 3 same | none | 6.406 | 906 s |
| #2 | @tanstack/react-query 4.36.1 → 5.108.0 | green | fixed: 3 of 3 failed on the head | 1 attempt, `src/lib.jsx`, $0.18, pushed | 101.979 | 1354 s |
| #1 | date-fns 2.30.0 → 4.4.0 | red | fixed: the head did not build | 1 attempt, `src/lib.jsx` + `src/pages/Checkout.jsx`, $0.16, pushed | 3.806 | 950 s |

The three failing head runs on PR #2 used 97.406 of its 101.979 credits. A failing journey costs far more than a
passing replay.

## 18. Census runs: journeys, control and what stays local (22 Nov 2026)

- **Command:** `bumpproof census --run [--limit n] [--only owner/repo]`. It takes eligible candidates from
  `census/candidates.json` in file order (newest pull request first) that have no row in `census/results.json` yet.
  The default limit is `census.run_limit` in config.
- **Journeys are added locally.** These repositories have no Bumpproof journeys. Two generic journeys from
  `config/census-journeys/` (home page shows content, main navigation works) and, when written, one journey for that
  app (`census/journeys/<owner>__<repo>/`) go into a local commit on top of the base (never pushed). The app's journey is written
  from its source before the run. An app served under a base path names it in `app.json` in that folder.
- **Authored once, then replayed.** The base is served and Kane CLI authors each journey. The recordings become a second
  local commit, and the head is the pull request merged on top of it. The check then replays the base recordings on
  the base and on the head, as for our own pull requests (§15).
- **Control (H4):** the authoring run and the replay on the same base code must agree. A journey that passed when it
  was authored and fails on the replay is a false alarm of the tool, and the row says so. A journey that never passed
  on the base is left out of both the control and the verdict.
- **Read only.** Nothing is pushed, commented or opened on these repositories. The local commits live in a temporary
  clone that is deleted after the run. A fix patch is written next to the run record in `census/runs/<id>/`.
- **Credits** count against the census budget (`kane.census_budget`) in `census/kredit.json`. The wall clock of every
  row adds up against `census.run_timebox_min`.

Census run 1 (22 Nov, Kane CLI 0.10.7; from `census/results.json`):

| Repository | Bump | CI | Verdict | Control | Credits | Time |
|---|---|---|---|---|---|---|
| gh-top-languages/builder #31 | vite ^8.3.2 → ^8.3.8 | green | safe | same | 139.25 | 1169 s |
| torn4dom4n/journey #90 | vite npm:@voidzero-dev/vite-plus-core@^1.6.0 → npm:@voidzero-dev/vite-plus-core@^8.3.8000 | red | could not run (base build failed) | not run | 0 | 40 s |
| ebcFlagman/wiis-pwa #144 | i18next 27.1.1 → 27.2.1 | green | safe | same | 125.463 | 1753 s |
| heriberto04/Trip-Logs #26 | next 15.3.3 → 15.5.29 | none | safe | same | 128.667 | 1475 s |
| sweksha-cloud/Fairlens-a #16 | vite 6.3.5 → 6.4.6 | green | safe | same | 124.783 | 1254 s |

5 repositories run, 4 runnable, 4 safe, 0 broken behind a green CI, 0 false alarms in the control. 518.163 credits in total.
Authoring the three journeys cost about 100 to 116 credits per repository; the check after it cost 14 to 26.

- **torn4dom4n/journey could not be served.** Its `vite` dependency is an npm alias for `vite-plus`, and the sandbox's
  Vite preset runs `npx --no-install vite preview`, which npm refused. Its own preview script does not take the host
  and port the sandbox needs either. This is a limit of Bumpproof, not of that repository, and the row says
  "could not run".
- **No break was found in this first run.** These were patch and minor bumps that CI had already passed. That is the
  honest result. The broken and fixed runs so far come from this repository's own Dependabot pull requests (§17).

Census run 2 (22 Nov, same method; from `census/results.json`):

| Repository | Bump | CI | Verdict | Control | Credits | Time |
|---|---|---|---|---|---|---|
| eames1127/GitGreens #32 | vite ^5.0.0 → ^8.3.8 | red | broken (head does not install) | same | 159.636 | 1171 s |
| TepMan/TarotApp #60 | vite ^8.3.5 → ^8.3.8 | green | safe | same | 166.064 | 1010 s |
| Guhan3132/nodeloop #20 | tailwindcss 4.3.3 → 4.3.5 | green | safe | same | 195.179 | 1578 s |
| julioczn/graphite #9 | vite ^6.4.4 → ^8.3.8 | red | could not run (no journey passed on the base) | not run | 117.195 | 512 s |
| mgurov/lokito #879 | @tanstack/react-query ^5.87.1 → 5.107.1 | green | could not run (pull request closed) | not run | 0 | 1 s |
| mohdaktham/tessera #12 | recharts ^3.10.1 → ^3.11.0 | red | could not run (base build failed) | not run | 0 | 7 s |
| drachenpapa/wyrmhort #913 | i18next 27.1.5 → 27.2.1 | green | could not run (base build failed) | not run | 0 | 6 s |
| Godwinzin/RepoGuard #10 | react-router-dom ^7.18.5 → ^7.18.6 | green | could not run (no journey passed on the base) | not run | 94.755 | 443 s |
| Abhirajgautam28/Chatraj #1391 | antd ^6.7.0 → ^6.7.1 | red | safe | same | 147.502 | 985 s |

Both runs together: 14 repositories run, 8 runnable, 7 safe, 1 broken, 0 broken behind a green CI, 0 false alarms in
the control (8 of 8 the same). 1398.494 census credits and 11404 s of wall clock, inside `census.run_timebox_min`.

- **GitGreens is a real break.** Dependabot raised vite to 8 and left `@vitejs/plugin-vue` at 5, whose peer range ends
  at vite 6, so `npm ci` stops with a peer dependency error. The pull request's own build, lint and test checks fail too. The fix is
  to raise `@vitejs/plugin-vue` as well (its latest release accepts vite 8). The fixer made no change in two attempts:
  the guards only let it add a package, never change another package's version (§11). The row stays broken, not
  fixed. graphite's head fails in the same way.
- **Apps that need a server are mostly out of reach.** TarotApp and RepoGuard need their own API server. TarotApp's page
  shell still loads, so its journey checks the page and its error state. RepoGuard's login page waits for a session
  check and shows an error, so nothing passed on the base. graphite is an Electron app whose web view needs the desktop
  bridge. tessera's base does not install with `npm ci`.
- **wyrmhort needs Node 24.** The sandbox image is `sandbox.image` in config (Node 22), and npm refuses the install.
  That is a limit of Bumpproof, not of the repository.
- **A journey can fail when authored and pass on the replay.** TarotApp's generic home journey did this. It is compared
  on the head, but it is not counted in the control, which needs a passing authored run.
- **CI and the result are separate.** Chatraj's CI was red for this pull request and every journey behaved the same on
  the head. The census reports what the app did, not what CI said.

## 19. The measured numbers on the pages (22 Nov 2026)

`bumpproof report` computes H1 to H6 in `src/report/metrics.ts` from committed files only. No number is typed into a
page or a locale file. Each tile names the files it reads.

- **H1** counts run records with a pull request number on this repository, by verdict and reason. Local branch runs
  and synthetic test records are left out.
- **H2** counts the evaluated candidates from the list in `census/candidates.json` (`eligible` plus `excluded`), not
  from its summary block, and the run and runnable rows from `census/results.json`.
- **H3 and H4** count census rows: `ci_green_but_broken`, and the control outcome. A row with no control (could not run)
  is not in the false alarm count.
- **H5 loop time** is `fixer_start` to `fixer_done` on the run timeline, for runs the fixer fixed. `fixer_start` comes
  right after the failed check, and `fixer_done` comes after Kane CLI has run every journey on the patch. Credits per
  pull request is the median of `credits_consumed` over H1 runs. The authoring against replay ratio uses census entries
  in the credit ledger: entries whose id has `-author:` are authoring runs, the rest are replays.
- **H6** divides fixed runs by runs where the fixer ran (`fix` is not null). Two early demo runs were checked without
  `--fix`; the fixer never saw them, so they are not in the count. The demo app and the census are shown apart.
- The census table becomes one card per repository below 40rem, so a long bump name no longer squeezes the columns.

## 20. The demo video is drawn from stills, frame by frame (22 Nov 2026)

`scripts/video-render.py` builds the video from the real stills that `scripts/video-shots.py` captures, a narration
folder, and the scene list in `scripts/video/timeline.json`. Each frame is a function of time: crop and zoom a still,
draw highlights, cards and captions, then pipe the frame to ffmpeg. A slow or busy machine gives the same video.

- Screen recording was not used. It drops frames under load and records the screen at its CSS size.
- Camera moves, highlight boxes, card text and pauses live in the JSON file. Changing a scene does not need code.
- Captions are the narration sentences, timed from the speech engine's character timings.
- The voice is the author's voice cloned with ElevenLabs. The end card and the README say so.
- Audio: each line is placed at its scene start, then normalised in two passes to -16.5 LUFS, true peak -2 dBTP.
  No music.
- Every number on screen comes from `docs/runs/20261122-0453-53ba/run.json`, `census/results.json` or README.md.

## 21. Installing from GitHub works with no build step (22 Nov 2026)

A test in a clean `node:22-alpine` container found three problems with the README commands.
`npm install -g github:aimanmalib/bumpproof` stopped at `sh: tsc: not found`, because the `prepare` build needs dev
dependencies that a global install does not have. `npx … replay docs/runs/<id>` from an empty folder could not find
the run. `bumpproof init` printed "not built yet" and looked like a success.

- `dist/` is now committed and `prepare` is gone, so npm installs the package as it is. `test/dist.test.ts` builds
  `src/` into a temporary folder and fails when the committed `dist/` differs. After changing `src/`, run
  `npm run compile`. `scripts/uji.sh` no longer builds in place, so CI cannot hide a stale `dist/`.
- The recorded runs ship in the package (`docs/runs/` in `files`, about 250 KB). `replay` reads a folder in the
  current directory first. If there is none, it uses the run with the same name inside the package. An unknown id
  still exits 2.
- A listed command that is not built yet exits 2.
- Even with no build step, `npm install -g github:…` linked the global package to a temporary clone that npm then
  deleted, so the `bumpproof` command was missing (npm 10.8 and 10.9, measured in `node:20-alpine` and
  `node:22-alpine`). `--install-links` makes npm pack the clone and install a real copy, so the install line is
  `npm install -g --install-links github:aimanmalib/bumpproof`. `npx github:…` was not affected.
- npm also runs a nested `npm install` inside a git clone when the package has a `build` script. Next to a global
  install the two collide (`ENOTEMPTY` in CI with a `#<sha>` spec). The build script is named `compile` for that reason.
- The `readme-commands` CI job runs the README commands from an empty folder on Node 20 and 22. On a push it installs
  `github:<repo>#<sha>`. On a pull request it installs `npm pack` of the checkout, because npm cannot fetch a merge
  commit. It runs inside `node:20-alpine` and `node:22-alpine`. On the Ubuntu runner itself the same install stopped
  with `GitFetcher requires an Arborist constructor to pack a tarball`. Clean Node containers did not show it: Alpine
  and Debian, root and a normal user, with and without SSH, Node 20 and 22, with and without a pinned commit. The
  cause is not known yet. If a user hits it, `npx github:aimanmalib/bumpproof <command>` is the way around.
- Undo: put `dist/` back in `.gitignore`, restore `prepare`, and change every install line to
  `npx github:aimanmalib/bumpproof <command>`. That form builds on first use and takes about 25 s.
