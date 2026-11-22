# Bumpproof: hackathon form text

The text for the KaneCLI Online Hackathon submission form, one section per field.
Each field sits between two markers, so its length can be checked by script.
Every number is from `docs/runs/*/run.json` and `census/results.json`, the same files the README and the report site read.

## Project name

<!-- name:start -->
Bumpproof
<!-- name:end -->

## One-liner (120 characters at most)

<!-- one-liner:start -->
Dependabot says the bump is safe. Bumpproof makes Kane CLI prove it in Chrome, and Claude Code fixes what breaks.
<!-- one-liner:end -->

## Project details (1500 characters at most)

<!-- details:start -->
Bumpproof is a CLI for anyone who merges Dependabot pull requests on a web app. CI being green does not mean the app still works.

One command takes a dependency pull request. It builds the base branch and the merge, each in its own Docker container. Kane CLI runs the same plain-English journeys in Chrome against both, and the base is the reference. The verdict is plain code over Kane CLI's results: safe, fixed, broken or could not run.

When the head breaks, Claude Code (headless, file tools only) gets Kane CLI's failed step, its remark, the new console errors and the release notes. It writes a patch. Guards reject patches that touch tests or CI, or change versions. The sandbox rebuilds the patch and Kane CLI replays every journey. Only when all of them pass is it "fixed". Then Bumpproof comments on the pull request and pushes the fix. It never merges.

Real runs, on pull requests Dependabot opened on this repository:
- #4 clsx 1 → 2: safe, 3 of 3 journeys same as base.
- #3 react-router-dom 6 → 7: CI green, the account tabs broke. Kane CLI caught it three times. 8-line fix, 3 of 3 pass. The fix is left off the branch so anyone can replay the catch.
- #2 @tanstack/react-query 4 → 5: CI green, but all three journeys failed on pages that crashed. 2-line fix, 3 of 3 pass.
- #1 date-fns 2 → 4: build failed. 6-line fix, 3 of 3 pass.

Census: 14 open pull requests in other people's repositories, run read-only. 8 could run. A base-against-base control gave 0 false alarms in 8.
<!-- details:end -->

## Agent used (80 characters at most)

<!-- agent:start -->
Claude Code
<!-- agent:end -->

## Anything else to add (4000 characters at most)

<!-- else:start -->
How the agent and Kane CLI talk to each other

Kane CLI runs each journey with `testmd run --agent --headless --bug-detection continue`. Bumpproof reads the JSON event stream: each step, healing, the exit code, the failed step and Kane CLI's remark, and `credits_consumed`. It also reads the console and network errors from the evidence pack. For a regression, all of that goes into the fixer's prompt as the bug report. After the patch is built, Kane CLI replays the failing journey first, then every other journey. The loop stops at the first failure. The fix counts only when Kane CLI passes everything.

What Kane CLI caught

On pull request #2 (@tanstack/react-query 4.36.1 → 5.108.0) Dependabot's CI was green. Kane CLI failed all three journeys on pages that crashed. Its remark on the account journey: "Opening Orders leads to a blank page, so the Past orders heading and expected orders cannot be shown." The console showed "Cannot read properties of undefined (reading 'orders')". The base passed the same journeys. Claude Code found the cause in the release notes: the `loading` status is now called `pending`. It changed one line in a loading check and wrote a note quoting the release note. Kane CLI then passed 3 of 3 on the patched build. Bumpproof commented and pushed the fix to the bot's branch.

The demo shop pins old major versions on purpose, so Dependabot's real pull requests meet real breaking changes. Nothing in the demo was broken by hand.

Numbers, all counted by script from the run records

- Credits per pull request: 6.4 (clsx, safe), 43.7 (react-router, fixed), 102 (react-query, fixed), 3.8 (date-fns, fixed).
- Fixer cost on the Claude API: $0.15, $0.18 and $0.16.
- Median time from the failed check to Kane CLI passing on the patch: 6 min 16 s, over 4 fixes.
- Census: 241 pull requests checked against the rules, 20 eligible, 14 run, 8 could run. CI green but broken: 0. False alarms in the control: 0 of 8.
- In the census, writing a journey cost 33.4 credits on average and replaying a recording cost 8.1.
- Breaks fixed: 4 of 4 on the demo app, 0 of 1 in the census.

How to run it

Without keys: open the report site, or run `npx github:aimanmalib/bumpproof replay docs/runs/20261122-0453-53ba` from any folder. It replays the recorded run in the terminal. It needs no keys and no credits, and the network only to download the package.

Live: Node 20+, Docker, `gh`, Kane CLI logged in, and Claude Code for `--fix`. Then `bumpproof doctor`, `bumpproof init`, and `bumpproof pr <owner>/<repo>#<number> --fix`.

Safety

The app under test runs in Docker as a normal user, with all capabilities dropped and install scripts off. The fixer has file tools only: no shell, no web, no MCP. Release notes reach it marked as untrusted. Comments and pushes work only on repositories listed in the config. In the census we opened no comments, issues or pull requests.

Limits

One demo app with three journeys. Most census apps could not start in the sandbox, because they need a database, an API or secrets. A failing journey costs many times the credits of a passing one. npm only.

What's next

Run the GitHub Action with Kane CLI journeys in CI, support pnpm and Yarn, and start apps that need a local database through Docker Compose.

How AI is used: the code was written with Claude Code, directed by the author. Claude Code is also the fixer inside the product. The demo video narration is the author's voice cloned with ElevenLabs.
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
