# Contributing

Thanks for looking. Bumpproof is small, and a bug report with a real pull request link helps most.

## Set up

Needs Node 22 (see `.nvmrc`).

```sh
npm ci
bash scripts/uji.sh        # type check and tests
```

`dist/` is committed. After changing `src/`, run `npm run compile`; a test fails when `dist/` is out of date.

Tests that need Docker, Kane CLI or Claude Code are off by default. Turn them on one at a time:
`BUMPPROOF_DOCKER=1`, `BUMPPROOF_KANE=1`, `BUMPPROOF_KANARI=1`. The last two use paid credits.

## Rules for changes

- TypeScript `strict`, ES modules, tests with `node:test`. One runtime dependency (`fflate`); please do not add more.
- Keep each file in `src/` under 400 lines.
- Values that may change live in `config/defaults.json`. Text lives in `locales/en.json` and `locales/ms.json`, with the
  same keys in both.
- A bug fix comes with a test that fails without it.
- Pages in `docs/` and the numbers in `README.md` are generated. Change the code, then run `bumpproof report`.
- Decisions with a reason go in [`docs/02-DECISIONS.md`](docs/02-DECISIONS.md).

## Pull requests

Small pull requests, one change each. Say what you ran to check it.
Do not include run records or evidence from private apps.
