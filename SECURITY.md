# Security

## Reporting a problem

Please report security problems privately, through
[GitHub private vulnerability reporting](https://github.com/aimanmalib/bumpproof/security/advisories/new).
Do not open a public issue. You should get a first reply within a week.

## What counts

Bumpproof builds and serves code from pull requests, and lets a coding agent edit files. Problems we want to hear about:

- A way for the app under test to leave the Docker sandbox or reach the host.
- A patch that gets past the fixer guards in `src/guards.ts`.
- A push or comment on a repository not listed in `pr.write_repos`.
- Secrets, e-mails or private links that get past the publication scan into `docs/` or a PR comment.

## Supported versions

Only the latest release gets fixes.
