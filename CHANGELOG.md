# Changelog

## 0.1.2 (26 Nov 2026)

- On npm: `npx bumpproof` and `npm install -g bumpproof`. The package carries the recorded runs, so `replay` works offline.
- Fixer: when the agent stops without changing a file and exits with an error, that error is the reason given, and it
  reaches the next attempt's prompt. The "Fixing:" line names the agent from `fixer.name`.
- README: "Use your own agent", with the config for OpenAI Codex CLI and the one measured run; the tags `pr1-as-opened`,
  `pr2-as-opened` and `pr3-as-opened` keep the commits Dependabot first opened, for the live replays.
- `AI_USAGE.md`: how AI is used to build and to run Bumpproof.
- Tests remove their temporary folders.

## 0.1.1 (23 Nov 2026)

- Install from GitHub works without a build step: `dist/` is committed, and the install line uses `--install-links`
  (a global git install without it was a link to a deleted clone). `replay` works from any folder.
- `bumpproof init`: writes `.bumpproof/config.json` and two or three draft journeys from the app's routes (file routes
  are read only in Next.js apps).
- Kane CLI step screenshots are kept for each run (the failed step, and the same step on the base and after the fix)
  and published on the run page.
- Each fixed run publishes `fixer-prompt.md`, the exact prompt the fixer was given.
- `pr --comment` says when a verified fix was left off the branch on purpose.
- Report site: favicon, and link-preview tags (Open Graph and an X card) with an image of the real home page.
- The pull request comment footer names the Bumpproof version recorded in the run, and says "a build from before its
  first release" instead of the `0.0.0` placeholder.
- `scripts/video-shots.py`: captures the stills for the demo video from real states (the pull request on GitHub, the demo
  shop at the base, the bot's commit and the fix, the replay, the report pages) and writes the numbers it may quote to `facts.json`.

## 0.1.0 (22 Nov 2026)

First release, built during the KaneCLI Online Hackathon.

- `bumpproof pr <owner>/<repo>#<number>`: checks a Dependabot or Renovate pull request in a Docker sandbox, base against head,
  with Kane CLI journeys in Chrome. `--fix` has Claude Code patch a regression or a failed build; Kane CLI replays every journey
  on the patch. `--comment` and `--push-fix` for repositories you allow.
- `check`, `fix`: the same loop on two local refs.
- `census`: finds open dependency pull requests in public repositories, runs them read-only, and records a base-against-base control.
- `report`: the static report site in English and Malay, and the numbers in `README.md`.
- `replay`: plays a recorded run in the terminal, with no credits and no network.
- `doctor`, `init`.
- GitHub Action: build check and comment only.
