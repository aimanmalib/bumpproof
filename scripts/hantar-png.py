#!/usr/bin/env python3
"""Draws the two optional attachments for the hackathon form, as PNG at 2x pixel density.

1. architecture.png: how one check runs, drawn in HTML with the report site's own stylesheet and fonts.
2. census.png: the English census page from docs/census.html, as published. Its numbers come from
   census/results.json through `bumpproof report`; nothing here types a number in.

Needs Python Playwright with Chromium. Usage:
  python3 scripts/hantar-png.py <out-dir>
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / 'docs'
DSF = 2

# One box per step: (lane, title, detail, file in this repository).
STEPS = [
    ('in', 'Dependabot pull request', 'Packages read from the package.json diff, not the title', 'src/bump.ts'),
    ('box', 'Docker sandbox', 'Base and merge built and served, one container each: non-root, all capabilities dropped, CPU and memory capped', 'src/sandbox.ts'),
    ('kane', 'Kane CLI in Chrome', 'The same *_test.md journeys on base and head. The base is the reference', 'src/kane.ts'),
    ('code', 'Verdict in code', 'Each journey: same, UI moved but held, regression, or inconclusive (one retry)', 'src/compare.ts'),
]
FIX = [
    ('agent', 'Claude Code writes a fix', 'Headless, file tools only. Gets Kane CLI\'s failed step, remark and console errors, plus the release notes', 'src/check-fix.ts'),
    ('guard', 'Guards on the patch', 'No test edits, no downgrades, no workflow files, no child_process, size limit', 'src/guards.ts'),
    ('kane', 'Kane CLI replays every journey', 'On a fresh build of the patched copy', 'src/check-fix.ts'),
]
ENDS = [
    ('safe', 'Safe', 'Every journey as on the base. Comment on the pull request'),
    ('fixed', 'Fixed', 'All journeys pass again. Comment, then push the fix'),
    ('broken', 'Broken', 'No patch passed. Comment with Kane CLI\'s evidence'),
]

CSS = """
body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--sans); }
.sheet { width: 1520px; padding: 40px; box-sizing: border-box; }
h1 { max-width: none; font-family: var(--display); font-size: 40px; margin: 0 0 6px; letter-spacing: -0.01em; }
.sub { color: var(--muted); font-size: 18px; margin: 0 0 32px; }
.row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 36px; position: relative; }
.row.fix { grid-template-columns: repeat(3, 1fr); margin-left: 369px; }
.step { background: var(--sheet); border: 2px solid var(--rule-strong); border-radius: var(--radius); padding: 16px 18px;
  position: relative; min-height: 132px; box-sizing: border-box; }
.step b { display: block; font-family: var(--display); font-size: 22px; margin-bottom: 6px; }
.step p { margin: 0 0 10px; font-size: 15.5px; line-height: 1.4; color: var(--ink-2); }
.step code { font-family: var(--mono); font-size: 13px; color: var(--link); }
.step.kane { border-color: var(--fixed); background: var(--fixed-wash); }
.step.agent { border-color: var(--unrunnable); background: var(--unrunnable-wash); }
.row.top .step:not(:last-child)::after { content: "→"; position: absolute; right: -31px; top: 44px; font-size: 26px; }
.row.fix .step:not(:first-child)::before { content: "←"; position: absolute; left: -31px; top: 44px; font-size: 26px; }
.drop { margin-left: 1273px; height: 64px; border-left: 2px solid var(--rule-strong); position: relative; }
.drop span { position: absolute; right: calc(100% + 12px); top: 20px; white-space: nowrap; font-size: 15px; color: var(--muted); }
.ends { display: grid; grid-template-columns: repeat(3, 1fr); gap: 36px; margin-top: 44px; }
.end { border-radius: var(--radius); padding: 14px 18px; font-size: 16px; }
.end b { font-family: var(--display); font-size: 22px; margin-right: 8px; }
.end.safe { background: var(--safe-wash); border-left: 6px solid var(--safe); }
.end.fixed { background: var(--fixed-wash); border-left: 6px solid var(--fixed); }
.end.broken { background: var(--broken-wash); border-left: 6px solid var(--broken); }
.loop { margin-top: 28px; font-size: 16px; color: var(--ink-2); border-top: 1px solid var(--rule); padding-top: 16px; }
"""


def esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def box(kind, title, detail, src):
    return f'<div class="step {kind}"><b>{esc(title)}</b><p>{esc(detail)}</p><code>{esc(src)}</code></div>'


def architecture_html():
    top = ''.join(box(*s) for s in STEPS)
    fix = ''.join(box(*s) for s in reversed(FIX))
    ends = ''.join(f'<div class="end {k}"><b>{esc(t)}</b>{esc(d)}</div>' for k, t, d in ENDS)
    css_href = (DOCS / 'assets' / 'site.css').as_uri()
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="{css_href}">
<style>{CSS}</style></head><body><div class="sheet">
<h1>Bumpproof: how one check runs</h1>
<p class="sub">bumpproof pr &lt;owner&gt;/&lt;repo&gt;#&lt;number&gt; --fix · one command, one pull request</p>
<div class="row top">{top}</div>
<div class="drop"><span>regression or failed build ↓</span></div>
<div class="row fix">{fix}</div>
<div class="ends">{ends}</div>
<p class="loop">The loop: Kane CLI's result goes into the fixer's prompt, and the fix counts only after Kane CLI passes every journey on it.
Nothing is merged. Release notes reach the fixer marked as untrusted input.</p>
</div></body></html>"""


def main(argv):
    if len(argv) != 2:
        sys.exit(__doc__)
    out = Path(argv[1]).resolve()
    out.mkdir(parents=True, exist_ok=True)
    tmp = out / '.architecture.html'
    tmp.write_text(architecture_html(), encoding='utf-8')
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={'width': 1520, 'height': 900}, device_scale_factor=DSF)
            page.goto(tmp.as_uri())
            page.evaluate('document.fonts.ready')
            page.locator('.sheet').screenshot(path=str(out / 'architecture.png'))
            page = browser.new_page(viewport={'width': 1440, 'height': 900}, device_scale_factor=DSF)
            page.goto((DOCS / 'census.html').as_uri())
            page.add_style_tag(content='[data-lang="en"] main { padding: 32px 40px; max-width: 1360px; }')
            page.evaluate('document.fonts.ready')
            page.locator('[data-lang="en"] main').screenshot(path=str(out / 'census.png'))
            browser.close()
    finally:
        tmp.unlink(missing_ok=True)
    for name in ('architecture.png', 'census.png'):
        print(out / name, (out / name).stat().st_size, 'bytes')


if __name__ == '__main__':
    main(sys.argv)
