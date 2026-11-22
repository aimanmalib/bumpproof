#!/usr/bin/env python3
"""Captures the real states the demo video is cut from, as stills at 3x pixel density.

1. The pull request on GitHub: the bot's commit with its CI checks, the fix commit, the Bumpproof comment.
2. The demo shop built at the base branch, at the bot's commit and at the fix commit (the page a journey broke on).
3. `bumpproof replay` of the recorded run, drawn as a terminal at three moments.
4. The report pages in docs/: home, the run page, the census, "For judges".

It also writes facts.json: every number the video script may say, read from the run record, the census results
and the GitHub API. Nothing is typed in by hand. Needs Python Playwright with Chromium, gh, git, npm. Usage:
  python3 scripts/video-shots.py docs/runs/<id> <out-dir>
"""
import functools
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

from terminal import SGR, page

ROOT = Path(__file__).resolve().parent.parent
VIEW = {'width': 1280, 'height': 720}
DSF = 3
BOT = 'dependabot[bot]'
SHOP_PAGES = {'home': '/', 'orders': '/account/orders'}
TERMINAL_STOPS = {'caught': 'Pull request · checkout: failed', 'fixing': 'writing a fix', 'verdict': None}
# Sticky and fixed bars would sit on top of an element screenshot that is taller than the window.
UNSTICK = """for (const el of document.querySelectorAll('body *')) {
  if (['sticky', 'fixed'].includes(getComputedStyle(el).position)) el.style.visibility = 'hidden';
}"""
REPORT_PAGES = {'home': 'index.html', 'census': 'census.html', 'judges': 'judges.html'}


class SpaHandler(http.server.SimpleHTTPRequestHandler):
    """Serves a folder; unknown paths without a file extension get index.html, like a single-page app host."""

    def send_head(self):
        path = Path(self.translate_path(self.path))
        if not path.exists() and '.' not in path.name:
            self.path = '/index.html'
        return super().send_head()

    def log_message(self, *args):
        pass


def serve(folder: Path) -> tuple[http.server.ThreadingHTTPServer, str]:
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(SpaHandler, directory=str(folder)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f'http://127.0.0.1:{server.server_address[1]}'


def sh(*args: str, cwd: Path = ROOT, stdin=None) -> str:
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=stdin is None, input=stdin).stdout


def pr_facts(run: dict) -> dict:
    src = run['source']
    repo = src['repo'].removeprefix('https://github.com/')
    commits = json.loads(sh('gh', 'api', f'repos/{repo}/pulls/{src["pr"]}/commits'))
    bot = [c for c in commits if (c.get('author') or {}).get('login') == BOT or c['commit']['author']['name'] == BOT]
    if not bot:
        sys.exit('no commit by the bot on this pull request')
    out = {'repo': repo, 'number': src['pr'], 'url': src['pr_url'], 'title': src['pr_title'], 'ci_at_run': src['ci'],
           'bot_sha': bot[-1]['sha'], 'head_sha': commits[-1]['sha'], 'checks': {}}
    for key in ('bot_sha', 'head_sha'):
        runs = json.loads(sh('gh', 'api', f'repos/{repo}/commits/{out[key]}/check-runs'))['check_runs']
        out['checks'][key] = {r['name']: r['conclusion'] for r in runs}
    return out


def build_shop(sha: str, app_dir: str, work: Path) -> Path:
    """The app folder at one commit, installed without lifecycle scripts and built, as the project's CI does."""
    folder = work / sha[:12]
    folder.mkdir()
    sh('git', 'fetch', '-q', 'origin', sha)
    archive = subprocess.run(['git', 'archive', f'{sha}:{app_dir}'], cwd=ROOT, check=True, capture_output=True).stdout
    sh('tar', '-x', '-C', str(folder), stdin=archive)
    sh('npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', cwd=folder)
    sh('npm', 'run', 'build', cwd=folder)
    return folder / 'dist'


def shoot_shop(browser, dist: Path, name: str, out: Path) -> dict:
    server, base = serve(dist)
    tab = browser.new_page(viewport=VIEW, device_scale_factor=DSF)
    errors: list[str] = []
    tab.on('pageerror', lambda e: errors.append(str(e).splitlines()[0]))
    try:
        for label, path in SHOP_PAGES.items():
            tab.goto(base + path, wait_until='networkidle')
            tab.wait_for_timeout(1500)
            tab.screenshot(path=str(out / f'shop-{name}-{label}.png'))
    finally:
        tab.close()
        server.shutdown()
    return {'page_errors': sorted(set(errors))}


def shoot_pr(browser, pr: dict, out: Path) -> None:
    tab = browser.new_page(viewport=VIEW, device_scale_factor=DSF)
    tab.goto(pr['url'], wait_until='domcontentloaded')
    tab.wait_for_timeout(3000)
    tab.screenshot(path=str(out / 'pr-top.png'))
    tab.evaluate(UNSTICK)
    comment = tab.locator('.timeline-comment, .js-comment-container').filter(has_text='Bumpproof:')
    if comment.count():
        comment.last.screenshot(path=str(out / 'pr-comment.png'))
    tab.goto(pr['url'] + '/commits', wait_until='domcontentloaded')
    tab.wait_for_timeout(3000)
    tab.screenshot(path=str(out / 'pr-commits.png'))
    tab.close()


def shoot_terminal(browser, run_dir: str, out: Path) -> None:
    env = {**os.environ, 'FORCE_COLOR': '1'}
    env.pop('NO_COLOR', None)
    text = subprocess.run(['node', str(ROOT / 'src/cli.ts'), 'replay', run_dir, '--speed', '0'], cwd=ROOT, env=env,
                          capture_output=True, text=True, check=True).stdout
    lines = text.rstrip('\n').split('\n')
    tab = browser.new_page(viewport=VIEW, device_scale_factor=DSF)
    for name, marker in TERMINAL_STOPS.items():
        end = len(lines) if marker is None else next(i for i, l in enumerate(lines) if marker in SGR.sub('', l)) + 1
        tab.set_content(page(lines[:end], f'$ npx github:aimanmalib/bumpproof replay {run_dir}'))
        tab.evaluate('document.fonts.ready')
        tab.screenshot(path=str(out / f'terminal-{name}.png'), full_page=True)
    tab.close()


def shoot_report(browser, run_id: str, out: Path) -> None:
    server, base = serve(ROOT / 'docs')
    tab = browser.new_page(viewport=VIEW, device_scale_factor=DSF)
    try:
        for name, path in {**REPORT_PAGES, 'run': f'runs/{run_id}/index.html'}.items():
            tab.goto(f'{base}/{path}', wait_until='networkidle')
            tab.screenshot(path=str(out / f'report-{name}.png'))
            tab.screenshot(path=str(out / f'report-{name}-full.png'), full_page=True)
    finally:
        tab.close()
        server.shutdown()


def main() -> None:
    run_dir, out = sys.argv[1], Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    run = json.loads((ROOT / run_dir / 'run.json').read_text())
    census = json.loads((ROOT / 'census/results.json').read_text())
    pr = pr_facts(run)
    facts = {'run': {k: run[k] for k in ('run_id', 'started_at', 'verdict', 'bumps', 'credits_consumed', 'duration_s')},
             'journeys': run['journeys'], 'timeline': run['timeline'],
             'fix': {k: v for k, v in run['fix'].items() if k != 'explanation'},
             'census': census['counts'], 'pr': pr, 'shop': {}}
    work = Path(tempfile.mkdtemp(prefix='bp-video-'))
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for name, sha in (('base', run['base']['sha']), ('bot', pr['bot_sha']), ('fixed', pr['head_sha'])):
                facts['shop'][name] = {'sha': sha, **shoot_shop(browser, build_shop(sha, run['app_dir'], work), name, out)}
            shoot_pr(browser, pr, out)
            shoot_terminal(browser, run_dir, out)
            shoot_report(browser, run['run_id'], out)
            browser.close()
    finally:
        shutil.rmtree(work, ignore_errors=True)
    (out / 'facts.json').write_text(json.dumps(facts, indent=2, ensure_ascii=False) + '\n')
    print(f'{out}: {len(list(out.glob("*.png")))} stills, facts.json')


if __name__ == '__main__':
    main()
