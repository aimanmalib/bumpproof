# Bumpproof: hackathon form text

The text for the KaneCLI Online Hackathon submission form, one section per field.
Each field sits between two markers, so its length can be checked by script.
Every number is from `docs/runs/*/run.json` and `census/results.json`, the same files the README and the report site read.

## Project name

<!-- name:start -->
Bumpproof
<!-- name:end -->

## One-liner (170 characters at most)

<!-- one-liner:start -->
Green CI on a Dependabot PR is not proof. Bumpproof has Kane CLI use the app in Chrome before and after the bump. Claude Code fixes what broke, then Kane checks the fix.
<!-- one-liner:end -->

## Project details (1500 characters at most)

<!-- details:start -->
A green check on a Dependabot pull request means the code builds. It does not mean the app still works. Bumpproof is a CLI for anyone who merges those pull requests on a web app.

One command builds the base branch and the pull request, each in its own Docker container. Kane CLI runs the app's plain-English journeys in Chrome on the base, as the reference, then on the pull request, and reports the step where a user gets stuck, and why. The verdict is plain code over Kane CLI's results. No model decides it.

When a journey breaks, Claude Code (headless, file tools only) gets Kane CLI's failed step, its remark, the new console errors and the release notes. Guards reject patches that touch tests, CI or versions. A fix counts only when Kane CLI passes every journey again. Then Bumpproof comments on the pull request and can push the fix. It never merges.

Real runs, on pull requests Dependabot opened on this repository:
- #2 @tanstack/react-query 4 → 5: CI green, all three journeys failed on crashed pages. 2-line fix, 3 of 3 pass.
- #3 react-router-dom 6 → 7: CI green, the account tabs broke. 8-line fix, 3 of 3 pass. The fix stays off the branch so anyone can replay the catch.
- #1 date-fns 2 → 4: build failed. 6-line fix, 3 of 3 pass.
- #4 clsx 1 → 2: safe, 3 of 3 the same as base.

I also ran it read-only on 14 open pull requests in other people's repositories. 8 could run: 7 safe, 1 broken build. A base-against-base control gave 0 false alarms in 8.
<!-- details:end -->

## Agent used (80 characters at most)

<!-- agent:start -->
Claude Code
<!-- agent:end -->

## Anything else to add (4000 characters at most)

<!-- else:start -->
How the agent and Kane CLI talk to each other

Kane CLI runs each journey with `testmd run --agent --headless --bug-detection continue`. Bumpproof reads its JSON event stream: every step, healing, the failed step, Kane CLI's remark, its result code and `credits_consumed`. It also reads the console and network errors from the evidence pack. On a regression, all of that goes into Claude Code's prompt as the bug report. A guard rejects any patch that edits a journey, so the agent cannot pass by changing the test. After the patch is built, Kane CLI replays the failing journey first, then every other journey. The fix counts only when Kane CLI passes all of them. If it does not, Kane CLI's new failure goes back for a second attempt. After two attempts the pull request is reported as broken, with the evidence.

What Kane CLI caught

On pull request #2 (@tanstack/react-query 4.36.1 → 5.108.0) CI was green. Kane CLI failed all three journeys. Its remark on the account journey: "Opening Orders leads to a blank page, so the Past orders heading and expected orders cannot be shown." The console showed "Cannot read properties of undefined (reading 'orders')". The base passed the same journeys. Claude Code found the cause in the release notes: the `loading` status is now called `pending`. It changed one loading check and quoted the release note. Kane CLI then passed 3 of 3 on the patched build, and Bumpproof pushed the fix to the bot's branch.

On #3 (react-router-dom 6.30.1 → 7.18.6) CI was also green, and the account journey failed at "Use the tabs again". That fix is on the run page, not the branch, so the catch can be run again.

The demo shop pins old major versions on purpose, so Dependabot's real pull requests meet real breaking changes. Nothing was broken by hand.

What Kane CLI did not catch

In the census, no pull request had green CI and a broken app: 0 of 8. The one break there also failed its own CI, and the fixer did not fix it. The demo shop is the only place I have green-CI catches. I report that as it is.

Numbers, counted by script from the run records

- Kane CLI credits per pull request: 6.4 (clsx, safe), 43.7 (react-router, fixed), 102 (react-query, fixed), 3.8 (date-fns, fixed).
- Fixer cost on the Claude API: $0.15, $0.18 and $0.16.
- Median time from the failed check to Kane CLI passing on the patch: 6 min 16 s, over 4 fixes.
- Census: 241 pull requests checked against fixed rules, 20 eligible, 14 run, 8 could run. False alarms in the control: 0 of 8.
- Writing a journey cost 33.4 credits on average. Replaying a recording cost 8.1.
- 253 tests pass in CI.

How to run it

No keys: `npx github:aimanmalib/bumpproof replay docs/runs/20261122-0453-53ba`, from any folder. It replays the recorded run of pull request #2 in the terminal. No credits are used.

Live: Node 20 or later, Docker, `gh`, Kane CLI logged in, and Claude Code for `--fix`. Then `bumpproof doctor`, `bumpproof init` and `bumpproof pr <owner>/<repo>#<number> --fix`.

Safety

The app under test runs in Docker as a normal user, with all capabilities dropped and install scripts off. The fixer has file tools only: no shell, no web, no MCP. Release notes reach it marked as untrusted. Comments and pushes work only on repositories listed in the config. In the census I opened no comments, issues or pull requests on other people's repositories.

Limits

One demo app with three journeys. 6 of the 14 census pull requests could not be run. A failing journey costs many times the credits of a passing one. A full check took 13 to 23 minutes. npm only. The loop starts from a developer's machine, not from CI.

What's next

Run the Kane CLI journeys from the GitHub Action, support pnpm and Yarn, and start apps that need a local database with Docker Compose.

How AI is used: Claude Code wrote the code, from a plan I approved. Claude Code is also the fixer inside the product. Kane CLI is an AI agent too. The demo video narration is my voice, cloned with ElevenLabs.
<!-- else:end -->

## Links

<!-- links:start -->
- GitHub URL: https://github.com/aimanmalib/bumpproof
- Live URL: https://aimanmalib.github.io/bumpproof/
- Demo video file (the YouTube upload is the same file): https://aimanmalib.github.io/bumpproof/media/bumpproof-demo.mp4
<!-- links:end -->

## Attachments

- `docs/hantar/architecture.png`: how one check runs.
- `docs/hantar/census.png`: the census table from the report site.
- `docs/hantar/before-after.png`: two Kane CLI screenshots of the same step in pull request #2, on the pull request and after the fix.
