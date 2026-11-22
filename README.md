# Bumpproof

Dependabot says the bump is safe. Bumpproof makes Kane CLI prove it in a real browser, and has your coding agent fix what breaks.

Status: work in progress, built during the KaneCLI Online Hackathon (12 to 26 November 2026).
This README lists only what has been built and measured.

Report site: https://aimanmalib.github.io/bumpproof/

## What it does

`bumpproof pr <owner>/<repo>#<number> --fix` takes one dependency pull request and:

1. Reads the pull request with `gh` and works out which packages changed from `package.json`, not from the title.
2. Merges the pull request onto the current tip of its base branch, in a fresh clone.
3. Builds and serves the base, then the merge, each in its own Docker container.
4. Runs the app's Kane CLI journeys (`*_test.md`) in Chrome against both. The base is the reference.
5. Decides the verdict in code (`src/compare.ts`): safe, fixed, broken or could not run.
6. On a regression or a failed build, Claude Code (headless) patches a copy, using the failure and the release notes.
   The sandbox rebuilds the copy and Kane CLI replays every journey. Only if all of them pass again is it "fixed".

With `--comment` it posts the result on the pull request. With `--push-fix` it pushes the verified fix to the pull
request branch as one new commit. It never merges.

## Results on this repository's own Dependabot pull requests

The demo app in `examples/shop` is written against older major versions, like many existing apps.
The pull requests below were opened by Dependabot. Each row is one `bumpproof pr … --fix --publish --comment --push-fix` run.

| Pull request | Change | CI on GitHub | Bumpproof | Kane CLI credits | Time |
|---|---|---|---|---|---|
| [#4](https://github.com/aimanmalib/bumpproof/pull/4) | clsx 1.2.1 → 2.1.1 | green | [Safe](https://aimanmalib.github.io/bumpproof/runs/20261122-0437-f93b/): 3 of 3 journeys same as base | 6.4 | 15 min |
| [#2](https://github.com/aimanmalib/bumpproof/pull/2) | @tanstack/react-query 4.36.1 → 5.108.0 | green | [Fixed](https://aimanmalib.github.io/bumpproof/runs/20261122-0453-53ba/): 3 of 3 journeys failed, 2-line fix, 3 of 3 pass | 102.0 | 23 min |
| [#1](https://github.com/aimanmalib/bumpproof/pull/1) | date-fns 2.30.0 → 4.4.0 | red | [Fixed](https://aimanmalib.github.io/bumpproof/runs/20261122-0516-0348/): build failed, 6-line fix, 3 of 3 pass | 3.8 | 16 min |

PR #2 is the case this tool is for: CI was green and every journey was broken.
The fixer cost $0.18 (PR #2) and $0.16 (PR #1) in Claude API usage.

## Run it

Needs Node 22, Docker, `gh` logged in, Kane CLI logged in, and Claude Code for `--fix`.

```sh
npm install -g github:aimanmalib/bumpproof
bumpproof doctor
bumpproof pr <owner>/<repo>#<number> --fix
```

Replay a recorded run in the terminal, with no credits and no network:

```sh
npx github:aimanmalib/bumpproof replay docs/runs/20261122-0453-53ba
```

## Safety

- The app under test runs in Docker with `--cap-drop ALL`, `no-new-privileges`, CPU, memory and process limits, the
  port bound to 127.0.0.1, and install scripts turned off.
- The fixer gets file tools only (Read, Edit, Write, Glob, Grep). No shell, no web. Guards reject patches that touch
  tests, journeys or CI files, change versions in `package.json`, add `child_process` or `eval`, or are too large
  (`src/guards.ts`).
- `--comment` and `--push-fix` work only on repositories listed in `config/defaults.json` (`pr.write_repos`).
  A fix is pushed only when each file it changes is the same on the branch as on the commit it was verified on.
  No force push.
- Published run records pass a scan for emails, tokens, cookies and private URLs before they are written.

## Limitations

- One demo app with three journeys so far. The census of other people's pull requests has not run yet.
- A failing journey costs far more credits than a passing one: PR #2 used 97.4 credits on the three failing head runs.
- Apps that need a database or other services are not supported.
- The GitHub Action only checks that the head builds and starts. Browser journeys and fixes run from the CLI.

## How AI is used

The code in this repository was written with Claude Code (Opus 5.5), directed by the author.
Claude Code in headless mode is also the fixer inside the product loop.
Fix commits pushed to pull requests say so in their message.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
