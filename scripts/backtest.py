#!/usr/bin/env python3
"""Backtest: Dependabot bumps that maintainers merged and then reverted, checked with Bumpproof.

  python3 scripts/backtest.py collect <work-folder> backtest/results.json   # from the local run records + GitHub
  python3 scripts/backtest.py render backtest/results.json backtest/README.md

`collect` reads each case's clone in <work-folder> (made by backtest/prepare.sh, one folder per case, named <id>-<time>),
takes the newest .bumpproof/runs/*/run.json, and asks GitHub for the bump commit's CI and the revert pull request.
Only the fields below are written: no logs, no local paths, no account data.
"""
import glob
import json
import os
import subprocess
import sys

CASES = [  # the order of the search results; see backtest/README.md "How the cases were chosen"
    {"id": "nodeflow", "repo": "jlab-sensing/NodeFlow", "pr": 105, "revert": 124, "dir": "frontend",
     "bump": "df0cc9a1a295f4f42fa58f684dece53ffebbf8c0", "change": "react-router-dom 7.18.4 → 7.18.5",
     "note": "The revert pull request gives no reason, so this may be a break our two journeys do not reach."},
    {"id": "lovedbyrobots", "repo": "Loved-by-Robots/lovedbyrobots-com", "pr": 20, "revert": 28, "dir": "",
     "bump": "dfb4e445737bbcc723f2e0f5d02d90a4413936c6", "change": "react-router 7.5.2 → 7.18.2"},
    {"id": "axfr", "repo": "Stenstromen/axfr-frontend", "pr": 45, "revert": 58, "dir": "",
     "bump": "d85bb9a7383493ffd58e2ba0b94ccecdb3768807", "change": "react 18.3.1 → 19.1.1"},
    {"id": "contentful", "repo": "contentful/marketplace-partner-apps", "pr": 4757, "revert": 5144, "dir": "apps/vwo-fme",
     "bump": "68a209e1406d9261614c861ae02dcc9f3beff35a", "change": "react 18.3.1 → 19.1.0"},
    {"id": "openpv", "repo": "open-pv/website", "pr": 433, "revert": 439, "dir": "",
     "bump": "7897f01c36c9bbad9dd68ed884490dbaaab72e22", "change": "react-dom 18.3.1 → 19.0.0"},
    {"id": "webcface", "repo": "na-trium-144/webcface-webui", "pr": 362, "revert": 370, "dir": "",
     "bump": "096ffcc493579539af6a32378a9aadb81559c3a9", "change": "react-konva 18.2.10 → 19.0.2"},
    {"id": "league", "repo": "dachrisch/leaguesphere", "pr": 57, "revert": 63, "dir": "liveticker",
     "bump": "434d355ab8d5e659df6029511ba0b08fcfeb2832", "change": "react-dom 18.3.1 → 19.0.0"},
    {"id": "observe", "repo": "gemini-hlsw/observe", "pr": 1582, "revert": 1592, "dir": "modules/web/client",
     "bump": "140690324f22a35ae446058b531a6b284ecd0d02", "change": "react 18.3.1 → 19.0.0"},
    {"id": "laura", "repo": "lauraAlabau/portfolio-2024", "pr": 81, "revert": 82, "dir": "",
     "bump": "c889d3517b22fa3f67272df45ecf1e72580da59e", "change": "react-router-dom 7.6.2 → 7.9.6"},
]


def gh(path):
    r = subprocess.run(["gh", "api", path], capture_output=True, text=True, timeout=60)
    return json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else None


def git(clone, *args):
    r = subprocess.run(["git", "-C", clone, *args], capture_output=True, text=True, timeout=60)
    return r.stdout.strip() if r.returncode == 0 else ""


def ci_of(repo, sha):
    runs = (gh(f"repos/{repo}/commits/{sha}/check-runs") or {}).get("check_runs", [])
    status = gh(f"repos/{repo}/commits/{sha}/status") or {}
    concl = sorted({c.get("conclusion") or c.get("status") for c in runs if c.get("name") != "Dependabot"})
    if not concl and not status.get("statuses"):
        return "none"
    if status.get("state") == "failure" or "failure" in concl:
        return "red"
    return "green" if concl and set(concl) <= {"success", "skipped", "neutral", "cancelled"} else "/".join(concl) or status.get("state")


def purity(clone, base, bump):
    """A pure bump changes only package.json and a lockfile, and every commit on the pull request is Dependabot's."""
    files = [f for f in git(clone, "diff", "--name-only", base, bump).splitlines() if f]
    second = git(clone, "rev-parse", "-q", "--verify", f"{bump}^2")
    authors = set((git(clone, "log", "--format=%an", f"{base}..{second}") if second else git(clone, "log", "-1", "--format=%an", bump)).splitlines())
    pure = all(os.path.basename(f) in ("package.json", "package-lock.json") for f in files) and authors <= {"dependabot[bot]"}
    return pure, files, sorted(authors)


def collect(work, out):
    rows = []
    for c in CASES:
        row = {k: c[k] for k in ("id", "repo", "pr", "revert", "dir", "change") if k in c}
        if c.get("note"):
            row["note"] = c["note"]
        row["pr_url"] = f"https://github.com/{c['repo']}/pull/{c['pr']}"
        row["revert_url"] = f"https://github.com/{c['repo']}/pull/{c['revert']}"
        row["bump_commit"] = c["bump"]
        clones = [p for p in sorted(glob.glob(os.path.join(work, c["id"] + "-*"))) + [os.path.join(work, c["id"])]
                  if os.path.isdir(os.path.join(p, ".git"))]
        if not clones:
            row["result"] = "not_run"
            rows.append(row)
            continue
        clone = clones[-1]
        base = git(clone, "rev-parse", f"{c['bump']}^1")
        row["base_commit"] = base
        row["pure"], row["changed_files"], row["authors"] = purity(clone, base, c["bump"])
        row["ci_on_bump"] = ci_of(c["repo"], c["bump"])
        # `bumpproof check --repo <clone>` writes its records under the clone's root, whatever --dir is.
        runs = sorted(set(glob.glob(os.path.join(clone, ".bumpproof", "runs", "*", "run.json"))
                          + glob.glob(os.path.join(clone, c["dir"] or ".", ".bumpproof", "runs", "*", "run.json"))),
                      key=os.path.getmtime)
        if not runs:
            row["result"] = "not_run"
            rows.append(row)
            continue
        r = json.load(open(runs[-1]))
        builds = {b["side"]: b for b in r.get("builds", [])}
        row["run_id"] = r["run_id"]
        row["verdict"] = r["verdict"]["verdict"]
        row["verdict_reason"] = r["verdict"].get("reason")
        row["head_build"] = {"built": builds.get("head", {}).get("built"), "failed_at": builds.get("head", {}).get("failed_at")}
        row["base_build"] = {"built": builds.get("base", {}).get("built"), "failed_at": builds.get("base", {}).get("failed_at")}
        row["journeys"] = [{"name": j["name"],
                            "base": (j.get("base") or {}).get("status"), "base_remark": (j.get("base") or {}).get("remark"),
                            "head": (j.get("head") or {}).get("status"), "head_remark": (j.get("head") or {}).get("remark")}
                           for j in r.get("journeys", [])]
        row["kane_credits"] = r.get("credits_consumed")
        row["seconds"] = r.get("duration_s")
        row["kane_cli_version"] = r.get("kane_cli_version")
        if not row["pure"]:
            row["result"] = "excluded_not_pure"
        elif row["verdict"] == "broken" and row["head_build"]["failed_at"]:
            row["result"] = "blocked_install" if row["head_build"]["failed_at"] == "install" else "blocked_build"
        elif row["verdict"] == "broken":
            row["result"] = "blocked_browser"
        elif row["verdict"] == "safe":
            row["result"] = "safe"
        else:
            row["result"] = "could_not_run"
        rows.append(row)
    doc = {"schema_version": 1, "generated_by": "scripts/backtest.py collect", "cases": rows}
    json.dump(doc, open(out, "w"), indent=2, ensure_ascii=False)
    open(out, "a").write("\n")
    print("wrote", out, {r["id"]: r["result"] for r in rows})


LABEL = {"blocked_install": "Blocked: the bump does not install", "blocked_build": "Blocked: the bump does not build",
         "blocked_browser": "Blocked: a journey breaks in Chrome", "safe": "Safe: every journey as on the base",
         "could_not_run": "Could not run", "excluded_not_pure": "Left out: not a pure Dependabot change", "not_run": "Not run"}
CI = {"none": "none", "green": "green", "red": "red"}


def render(src, out):
    d = json.load(open(src))
    rows = d["cases"]
    n = len(rows)
    count = lambda k: sum(1 for r in rows if r["result"] == k)
    blocked = count("blocked_install") + count("blocked_build") + count("blocked_browser")
    credits = round(sum(r.get("kane_credits") or 0 for r in rows), 1)
    lines = [
        "# Backtest: Dependabot bumps that maintainers merged and then reverted",
        "",
        f"{n} real pull requests in other people's public repositories. Each was a Dependabot bump that was merged and later",
        "reverted by the maintainers. Bumpproof checked the commit before the bump against the bump itself, with the two",
        "generic census journeys and Kane CLI in Chrome. Read only: nothing was opened or posted on those repositories.",
        "",
        f"- Blocked before merge: **{blocked} of the {sum(1 for r in rows if r.get('pure'))} pure Dependabot bumps**"
        + f" ({count('blocked_browser')} breaks in Chrome, {count('blocked_install')} do not install).",
        f"- Safe on our journeys: {count('safe')}. Could not run: {count('could_not_run')}. Left out as not a pure bump: "
        f"{count('excluded_not_pure')}. Not run: {count('not_run')}.",
        f"- Kane CLI credits in all: {credits}.",
        "",
        "| Pull request | Change | CI on the bump | Kane CLI on the base | On the bump | Bumpproof | Revert |",
        "|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        if (r.get("base_build") or {}).get("failed_at"):
            base_seen = f"base does not {'install' if r['base_build']['failed_at'] == 'install' else 'build'}"
        else:
            base_seen = "; ".join(f"{j['name']}: {j['base']}" for j in r.get("journeys", [])) or "—"
        hb = (r.get("head_build") or {}).get("failed_at")
        if hb:
            head_seen = "does not install" if hb == "install" else f"fails at {hb}"
        else:
            head_seen = "; ".join(f"{j['name']}: {j['head']}" for j in r.get("journeys", []) if j.get("head")) or "—"
        lines.append(f"| [{r['repo']}#{r['pr']}]({r['pr_url']}) | {r['change']} | {CI.get(r.get('ci_on_bump'), r.get('ci_on_bump') or '—')} | "
                     f"{base_seen} | {head_seen} | {LABEL[r['result']]} | [#{r['revert']}]({r['revert_url']}) |")
    lines += ["", "## Notes on each case", ""]
    for r in rows:
        note = f"- **{r['repo']}#{r['pr']}** ({r['change']}): {LABEL[r['result']]}." + (f" {r['note']}" if r.get("note") else "")
        if r["result"] == "excluded_not_pure":
            extra = [f for f in r.get("changed_files", []) if os.path.basename(f) not in ("package.json", "package-lock.json")]
            note += f" The pull request also changed {', '.join(extra[:3])}" + (f" and was edited by {', '.join(a for a in r['authors'] if a != 'dependabot[bot]')}" if any(a != "dependabot[bot]" for a in r.get("authors", [])) else "") + "."
        if r["result"] in ("could_not_run", "excluded_not_pure") and (r.get("head_build") or {}).get("failed_at") == "install":
            note += " The bump does not install either (`npm ci`)."
        if (r.get("base_build") or {}).get("failed_at"):
            note += f" The base itself failed at {r['base_build']['failed_at']}."
        for j in r.get("journeys", []):
            if j.get("base_remark") and j["base"] != "passed":
                note += f" On the base, {j['name']}: \"{j['base_remark']}\""
            if j.get("head_remark") and j.get("head") not in (None, "passed"):
                note += f" On the bump, {j['name']}: \"{j['head_remark']}\""
        lines.append(note)
    lines += [
        "",
        "## How the cases were chosen",
        "",
        "Run on 26 and 27 November 2026, 23:52 to 00:34 MYT, the night the hackathon closed:",
        "",
        "1. GitHub search for merged pull requests titled `Revert \"Bump react from 18`, `Revert \"Bump react-dom from 18`,",
        "   `Revert \"Bump react-router-dom from 6` and `Revert \"Bump @tanstack/react-query from 4`, and the original pull request",
        "   each one reverts: 79 found. The first 45, in search order, were screened; there was no time for the rest.",
        "2. Kept: npm lockfile in the changed folder, a Vite or Create React App front end, a runtime package (not `@types/*`).",
        "3. A case counts only when the pull request is a pure Dependabot change: only `package.json` and the lockfile, and",
        "   only Dependabot's commits. This rule was added after the first case turned out to have hand edits; that case",
        "   stays in the table, left out of the counts.",
        "4. Base = the first parent of the bump's merge commit; bump = the merge commit. Journeys = `config/census-journeys/`,",
        "   committed locally on the base. Every screened case that met rule 2 is in the table, in search order, including the",
        "   ones that could not run.",
        "",
        "To run one again: `backtest/prepare.sh <id> <git-url> <bump-merge-commit> <app-folder>`, then",
        "`bumpproof check --repo <clone> --base bt-base --head bt-head --dir <app-folder>`.",
        "",
        "Limits: two generic journeys only, so a break deeper in an app can pass, and a revert can have other reasons. "
        "Two of the blocked bumps fail `npm ci`, which CI would also catch; webcface-webui installs and builds, and breaks "
        "only in the browser. None of the three repositories ran CI on the bump. Four apps could not run in the sandbox at "
        "all. A small sample from one search, not a catch rate.",
        "",
    ]
    open(out, "w").write("\n".join(lines))
    print("wrote", out)


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "collect":
        collect(sys.argv[2], sys.argv[3])
    elif len(sys.argv) == 4 and sys.argv[1] == "render":
        render(sys.argv[2], sys.argv[3])
    else:
        sys.exit(__doc__)
