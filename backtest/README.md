# Backtest: Dependabot bumps that maintainers merged and then reverted

9 real pull requests in other people's public repositories. Each was a Dependabot bump that was merged and later
reverted by the maintainers. Bumpproof checked the commit before the bump against the bump itself, with the two
generic census journeys and Kane CLI in Chrome. Read only: nothing was opened or posted on those repositories.

- Blocked before merge: **3 of the 8 pure Dependabot bumps** (1 breaks in Chrome, 2 do not install).
- Safe on our journeys: 1. Could not run: 4. Left out as not a pure bump: 1. Not run: 0.
- Kane CLI credits in all: 423.7.

| Pull request | Change | CI on the bump | Kane CLI on the base | On the bump | Bumpproof | Revert |
|---|---|---|---|---|---|---|
| [jlab-sensing/NodeFlow#105](https://github.com/jlab-sensing/NodeFlow/pull/105) | react-router-dom 7.18.4 → 7.18.5 | green | home: passed; nav: passed | home: passed; nav: passed | Safe: every journey as on the base | [#124](https://github.com/jlab-sensing/NodeFlow/pull/124) |
| [Loved-by-Robots/lovedbyrobots-com#20](https://github.com/Loved-by-Robots/lovedbyrobots-com/pull/20) | react-router 7.5.2 → 7.18.2 | red | base does not install | — | Could not run | [#28](https://github.com/Loved-by-Robots/lovedbyrobots-com/pull/28) |
| [Stenstromen/axfr-frontend#45](https://github.com/Stenstromen/axfr-frontend/pull/45) | react 18.3.1 → 19.1.1 | none | home: passed; nav: failed | does not install | Left out: not a pure Dependabot change | [#58](https://github.com/Stenstromen/axfr-frontend/pull/58) |
| [contentful/marketplace-partner-apps#4757](https://github.com/contentful/marketplace-partner-apps/pull/4757) | react 18.3.1 → 19.1.0 | none | home: failed; nav: failed | does not install | Could not run | [#5144](https://github.com/contentful/marketplace-partner-apps/pull/5144) |
| [open-pv/website#433](https://github.com/open-pv/website/pull/433) | react-dom 18.3.1 → 19.0.0 | none | home: passed; nav: passed | does not install | Blocked: the bump does not install | [#439](https://github.com/open-pv/website/pull/439) |
| [na-trium-144/webcface-webui#362](https://github.com/na-trium-144/webcface-webui/pull/362) | react-konva 18.2.10 → 19.0.2 | none | home: passed; nav: passed | home: failed; nav: failed | Blocked: a journey breaks in Chrome | [#370](https://github.com/na-trium-144/webcface-webui/pull/370) |
| [dachrisch/leaguesphere#57](https://github.com/dachrisch/leaguesphere/pull/57) | react-dom 18.3.1 → 19.0.0 | none | home: passed; nav: passed | does not install | Blocked: the bump does not install | [#63](https://github.com/dachrisch/leaguesphere/pull/63) |
| [gemini-hlsw/observe#1582](https://github.com/gemini-hlsw/observe/pull/1582) | react 18.3.1 → 19.0.0 | none | base does not install | — | Could not run | [#1592](https://github.com/gemini-hlsw/observe/pull/1592) |
| [lauraAlabau/portfolio-2024#81](https://github.com/lauraAlabau/portfolio-2024/pull/81) | react-router-dom 7.6.2 → 7.9.6 | none | home: failed; nav: failed | — | Could not run | [#82](https://github.com/lauraAlabau/portfolio-2024/pull/82) |

## Notes on each case

- **jlab-sensing/NodeFlow#105** (react-router-dom 7.18.4 → 7.18.5): Safe: every journey as on the base. The revert pull request gives no reason, so this may be a break our two journeys do not reach.
- **Loved-by-Robots/lovedbyrobots-com#20** (react-router 7.5.2 → 7.18.2): Could not run. The base itself failed at install.
- **Stenstromen/axfr-frontend#45** (react 18.3.1 → 19.1.1): Left out: not a pure Dependabot change. The pull request also changed src/components/NavBar.jsx and was edited by Stenstromen. The bump does not install either (`npm ci`). On the base, nav: "Opening the site’s .SE navigation link shows an application error instead of page content."
- **contentful/marketplace-partner-apps#4757** (react 18.3.1 → 19.1.0): Could not run. The bump does not install either (`npm ci`). On the base, home: "After repeated waits, only an empty root is present and no app content rendered." On the base, nav: "Child agent failed: Final verification failed: "the home page still shows its content""
- **open-pv/website#433** (react-dom 18.3.1 → 19.0.0): Blocked: the bump does not install.
- **na-trium-144/webcface-webui#362** (react-konva 18.2.10 → 19.0.2): Blocked: a journey breaks in Chrome. On the bump, home: "The homepage loads as a blank page because its startup components use incompatible React versions." On the bump, nav: "The home page loads as a blank screen instead of showing its content."
- **dachrisch/leaguesphere#57** (react-dom 18.3.1 → 19.0.0): Blocked: the bump does not install.
- **gemini-hlsw/observe#1582** (react 18.3.1 → 19.0.0): Could not run. The base itself failed at install.
- **lauraAlabau/portfolio-2024#81** (react-router-dom 7.6.2 → 7.9.6): Could not run. On the base, home: "The homepage loads its files but then crashes before showing any app content." On the base, nav: "The home page loaded as a blank screen, so there was no content to verify or navigation to follow."

## How the cases were chosen

Run on 26 and 27 November 2026, 23:52 to 00:34 MYT, the night the hackathon closed:

1. GitHub search for merged pull requests titled `Revert "Bump react from 18`, `Revert "Bump react-dom from 18`,
   `Revert "Bump react-router-dom from 6` and `Revert "Bump @tanstack/react-query from 4`, and the original pull request
   each one reverts: 79 found. The first 45, in search order, were screened; there was no time for the rest.
2. Kept: npm lockfile in the changed folder, a Vite or Create React App front end, a runtime package (not `@types/*`).
3. A case counts only when the pull request is a pure Dependabot change: only `package.json` and the lockfile, and
   only Dependabot's commits. This rule was added after the first case turned out to have hand edits; that case
   stays in the table, left out of the counts.
4. Base = the first parent of the bump's merge commit; bump = the merge commit. Journeys = `config/census-journeys/`,
   committed locally on the base. Every screened case that met rule 2 is in the table, in search order, including the
   ones that could not run.

To run one again: `backtest/prepare.sh <id> <git-url> <bump-merge-commit> <app-folder>`, then
`bumpproof check --repo <clone> --base bt-base --head bt-head --dir <app-folder>`.

Limits: two generic journeys only, so a break deeper in an app can pass, and a revert can have other reasons. Two of the blocked bumps fail `npm ci`, which CI would also catch; webcface-webui installs and builds, and breaks only in the browser. None of the three repositories ran CI on the bump. Four apps could not run in the sandbox at all. A small sample from one search, not a catch rate.
