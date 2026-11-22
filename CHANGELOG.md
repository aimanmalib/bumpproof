# Changelog

## Unreleased

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
