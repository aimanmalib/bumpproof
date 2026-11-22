<p align="center"><img src="brand/logo-512.png" width="112" height="112" alt="Bumpproof"></p>

<h1 align="center">Bumpproof</h1>

<p align="center"><b>Dependabot says the bump is safe. Bumpproof makes Kane CLI prove it in a real browser, and has your coding agent fix what breaks.</b><br>
<a href="https://aimanmalib.github.io/bumpproof/"><b>Report site</b></a> · <a href="#judge-it-in-2-minutes">Judge it in 2 minutes</a> · <a href="#run-it-live">Run it live</a> · <a href="#limitations">Limitations</a> · <a href="#bahasa-melayu">Bahasa Melayu</a><br>
Built in Malaysia by Aiman Malib</p>

<p align="center"><a href="https://github.com/aimanmalib/bumpproof/actions/workflows/ci.yml"><img src="https://github.com/aimanmalib/bumpproof/actions/workflows/ci.yml/badge.svg" alt="CI"></a> <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0"></a></p>

![Replay of a recorded run: the bump breaks every journey, Claude Code writes a two-line fix, Kane CLI passes all three again](docs/media/bumpproof-loop.gif)

- Demo video, 3 minutes, narrated: https://aimanmalib.github.io/bumpproof/media/bumpproof-demo.mp4
- Report site: https://aimanmalib.github.io/bumpproof/
- Census of other people's pull requests: https://aimanmalib.github.io/bumpproof/census.html
- For judges, one page: https://aimanmalib.github.io/bumpproof/judges.html

<p align="center"><img src="docs/images/screenshot-desktop.png" width="640" alt="The report site on desktop: the overview page"> <img src="docs/images/screenshot-mobile.png" width="180" alt="The report site on an iPhone"></p>

## For judges

The three bars and the four dimensions of the KaneCLI Online Hackathon, and where to check each one.

| | What is asked | Where to check it |
|---|---|---|
| P1 | It works end to end | Pull request [#2](https://github.com/aimanmalib/bumpproof/pull/2): Dependabot opened it, CI was green, Bumpproof commented and pushed a verified fix. [Run page](https://aimanmalib.github.io/bumpproof/runs/20261122-0453-53ba/). |
| P2 | Kane CLI caught or proved something | On #2 Kane CLI found the Orders page blank after the bump, while the base passed. Its bug detection gave the failed step and the reason. |
| P3 | The agent and Kane CLI talked to each other | Kane CLI's failed step, remark and console errors go into the fixer's prompt ([`src/check-fix.ts#L32`](src/check-fix.ts#L32)). Kane CLI then replays every journey on the patch ([`src/check-fix.ts#L60`](src/check-fix.ts#L60)). |
| K1 | Ships | `npx github:aimanmalib/bumpproof replay docs/runs/20261122-0453-53ba` runs from an empty folder on Node 20 and 22. CI runs it that way, and the full test suite, on every push. |
| K2 | Verified | The verdict is plain code over Kane CLI's results ([`src/compare.ts`](src/compare.ts)), with the base branch as the reference. The census also runs base against base, as a control. |
| K3 | Closed loop | One command goes from the pull request to a fix that Kane CLI has passed. The fix is pushed only after that ([`src/pr.ts`](src/pr.ts)). |
| K4 | Craft | Docker sandbox, file-only fixer with guards ([`test/guards.test.ts`](test/guards.test.ts)), English and Malay output, every number below counted from JSON. |

## Results

<!-- bumpproof:numbers:start -->

Each row is one `bumpproof pr … --fix --publish --comment --push-fix` run on a pull request Dependabot opened on this repository. Nothing was merged.

| Pull request | Change | CI on GitHub | Bumpproof | Kane CLI credits | Fixer (Claude API) | Time |
|---|---|---|---|---|---|---|
| [#4](https://github.com/aimanmalib/bumpproof/pull/4) | clsx 1.2.1 → 2.1.1 | green | [Safe](https://aimanmalib.github.io/bumpproof/runs/20261122-0437-f93b/): 3 of 3 journeys same as base | 6.4 | — | 15 min 06 s |
| [#2](https://github.com/aimanmalib/bumpproof/pull/2) | @tanstack/react-query 4.36.1 → 5.108.0 | green | [Fixed](https://aimanmalib.github.io/bumpproof/runs/20261122-0453-53ba/): 3 of 3 journeys failed, 2-line fix, 3 of 3 pass | 102 | $0.18 | 22 min 34 s |
| [#1](https://github.com/aimanmalib/bumpproof/pull/1) | date-fns 2.30.0 → 4.4.0 | red | [Fixed](https://aimanmalib.github.io/bumpproof/runs/20261122-0516-0348/): build failed, 6-line fix, 3 of 3 pass | 3.8 | $0.16 | 15 min 50 s |

The other numbers, counted the same way as on the report site:

- **H2 Census of third-party pull requests: 8 of 14.** 241 pull requests checked against the rules, 20 eligible, 14 run. 8 could be run in the sandbox. Source: `census/results.json · census/candidates.json`.
- **H3 CI green, app broken: 0.** Census pull requests where CI was green or absent but Kane CLI found a break: 0 of 8. Source: `census/results.json`.
- **H4 False alarms in the control run: 0 of 8.** Base replayed against base: 8 same, 0 false alarm, 0 inconclusive. Source: `census/results.json`.
- **H5 Fix loop time and credits: 8 min 02 s.** Median time from the failed check to Kane CLI passing on the patch, over 3 fixes. Median 6.4 Kane CLI credits per pull request (3 pull requests). In the census, authoring a journey cost 33.4 credits on average and replaying a recording cost 8.1. That is 4.1 to 1. Source: `docs/runs/*/run.json · census/kredit.json`.
- **H6 Breaks fixed: 3 of 4.** Among runs with the fixer switched on: 3 of 3 on the demo app, 0 of 1 in the census. 5 attempts in all. Source: `docs/runs/*/run.json · census/runs/*/run.json`.

<!-- bumpproof:numbers:end -->

## Judge it in 2 minutes

No keys and no credits. The replay needs the network once, to download the package.

1. Open the [report site](https://aimanmalib.github.io/bumpproof/) and a run page.
2. Replay a recorded run in your terminal:

   ```sh
   npx github:aimanmalib/bumpproof replay docs/runs/20261122-0453-53ba
   ```

3. Check the numbers against the files they come from: [`docs/runs/*/run.json`](docs/runs) and
   [`census/results.json`](census/results.json).

## Run it live

Needs Node 20 or later, Docker, `gh` logged in, Kane CLI logged in, and Claude Code for `--fix`.

```sh
npm install -g --install-links github:aimanmalib/bumpproof
bumpproof doctor
bumpproof init                                  # writes .bumpproof/config.json and draft journeys
bumpproof pr <owner>/<repo>#<number> --fix      # check one pull request, fix what breaks
```

If the global install fails, `npx github:aimanmalib/bumpproof <command>` runs the same commands.

`--comment` posts the result on the pull request. `--push-fix` pushes the verified fix to the pull request branch.
Both work only on repositories you list in `pr.write_repos`. Bumpproof never merges.

Kane CLI reads `KANE_USERNAME` and `KANE_ACCESS_KEY` from the environment, or uses its own login.
The fixer runs `claude -p`; set `ANTHROPIC_API_KEY` or log in to Claude Code first.
Every setting is in [`config/defaults.json`](config/defaults.json). A `.bumpproof/config.json` in your app overrides it.

## How it works

`bumpproof pr <owner>/<repo>#<number> --fix` takes one dependency pull request and:

1. Reads the pull request with `gh` and works out which packages changed from `package.json`, not from the title.
2. Merges the pull request onto the current tip of its base branch, in a fresh clone.
3. Builds and serves the base, then the merge, each in its own Docker container.
4. Runs the app's Kane CLI journeys (`*_test.md`) in Chrome against both. The base is the reference.
5. Decides the verdict in code: safe, fixed, broken or could not run.
6. On a regression or a failed build, Claude Code (headless) patches a copy, using Kane CLI's failure and the release notes.
   The sandbox rebuilds the copy and Kane CLI replays every journey. Only if all of them pass again is it "fixed".

```mermaid
flowchart LR
  PR[Dependabot pull request] --> B[Build base and head<br>in Docker]
  B --> K1[Kane CLI journeys<br>on base and head]
  K1 --> V{Verdict in code}
  V -->|same| S[Safe]
  V -->|regression or build failed| F[Claude Code writes a fix<br>file tools only, guarded]
  F --> K2[Rebuild, Kane CLI<br>replays every journey]
  K2 -->|all pass| X[Fixed: comment and push the fix]
  K2 -->|still failing| R[Broken: comment with the evidence]
```

## Where Kane CLI is used

| What | Where |
|---|---|
| `kane-cli testmd run <journey> --agent --headless --bug-detection continue` | [`src/kane.ts#L139`](src/kane.ts#L139), flags in [`config/defaults.json#L85`](config/defaults.json#L85) |
| One journey run, refused when the credit budget is spent | [`src/journeys.ts#L88`](src/journeys.ts#L88), budget [`src/kane.ts#L186`](src/kane.ts#L186) |
| Reading the JSON event stream: steps, healing, `run_end`, `test_md_done` | [`src/kane.ts#L57`](src/kane.ts#L57) |
| `credits_consumed` per run, added to a ledger | [`src/kane.ts#L106`](src/kane.ts#L106), ledger [`census/kredit.json`](census/kredit.json) |
| Exit code to pass or fail, and the bug detection code in the PR comment | [`src/compare.ts#L43`](src/compare.ts#L43), [`src/report/markdown.ts#L42`](src/report/markdown.ts#L42) |
| Evidence pack (`.evidence` zip): console and network errors, scrubbed before publishing | [`src/evidence.ts#L26`](src/evidence.ts#L26), [`src/evidence.ts#L116`](src/evidence.ts#L116) |
| Kane CLI's failure handed to the fixer, then the replay on the patch | [`src/check-fix.ts#L32`](src/check-fix.ts#L32), [`src/check-fix.ts#L60`](src/check-fix.ts#L60) |
| Journeys authored once on a census repository's base, then replayed | [`src/census-run.ts#L86`](src/census-run.ts#L86) |

## Bumpproof and kane-cli-pr

Kane CLI has an official GitHub Action, `kane-cli-pr`. It runs when a person comments `@kane-cli` on a pull request, against
tests linked in Test Manager. Bumpproof starts from the bot's pull request itself, uses the base branch as the reference so no
tests need to be set up first, and has a coding agent write the migration. They work well side by side.

The GitHub Action in this repository ([`action.yml`](action.yml)) only checks that the head builds and starts, and comments.
It needs no LLM key. Browser journeys and fixes run from the CLI.

## Safety

- The app under test runs in Docker with `--cap-drop ALL`, `no-new-privileges`, CPU, memory and process limits, the
  port bound to 127.0.0.1, and install scripts turned off ([`src/sandbox.ts`](src/sandbox.ts)).
- The fixer gets file tools only (Read, Edit, Write, Glob, Grep). No shell, no web, no MCP. Guards reject patches that touch
  tests, journeys or CI files, change versions in `package.json`, add `child_process` or `eval`, or are too large
  ([`src/guards.ts`](src/guards.ts)).
- Release notes reach the fixer marked as untrusted input ([`prompts/fixer.md`](prompts/fixer.md)).
- `--comment` and `--push-fix` work only on repositories listed in `pr.write_repos`. A fix is pushed only when each
  file it changes is the same on the branch as on the commit it was verified on. No force push.
- The census only reads other people's repositories. No comments, issues or pull requests were opened on them. Patches stay
  in this repository's report.
- Published run records pass a scan for emails, tokens, cookies and private URLs before they are written.

See [SECURITY.md](SECURITY.md) to report a problem.

## Limitations

- One demo app with three journeys. The census is small, and most apps found could not run in the sandbox.
- A failing journey costs many times the credits of a passing one.
  See the head runs on the [#2 run page](https://aimanmalib.github.io/bumpproof/runs/20261122-0453-53ba/).
- Kane CLI heals small UI changes. A journey that passes after healing is reported as "UI moved, still works", not
  silently as the same.
- Apps that need a database, an API server or secrets to start are not supported. The census marks them as could not run.
- npm only. One app directory per run.

## How AI is used

The code in this repository was written with Claude Code (Opus 5.5), directed by the author.
Claude Code in headless mode is also the fixer inside the product loop. Fix commits pushed to pull requests say so in their message.
Kane CLI, which drives Chrome, is an AI agent too.

AI disclosure: code and docs written with an AI coding agent; the fixer is an AI agent; the demo video narration is the
author's voice cloned with ElevenLabs.

## Built during the KaneCLI Online Hackathon

Built during the KaneCLI Online Hackathon (12–26 Nov 2026). First commit:
[`813035c`](https://github.com/aimanmalib/bumpproof/commit/813035c), 21 Nov 2026.
Changes are listed in [CHANGELOG.md](CHANGELOG.md). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).

## Bahasa Melayu

Bumpproof menyemak PR naik taraf pakej (Dependabot atau Renovate) dalam pelayar sebenar. Ia membina aplikasi dua kali dalam
Docker, sekali pada cawangan asas dan sekali pada PR. Kane CLI menjalankan perjalanan pengguna yang sama dalam Chrome pada
kedua-duanya. Bila PR merosakkan perjalanan, Claude Code menulis pembaikan dan Kane CLI menjalankan semula semua perjalanan.
Ia tidak pernah menggabung PR.

Laman laporan dalam Bahasa Melayu: https://aimanmalib.github.io/bumpproof/?lang=ms

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
