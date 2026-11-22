#!/usr/bin/env python3
"""Renders `bumpproof replay <run>` as an animated GIF for the README.

The frames are the real replay output of a recorded run (colours included), drawn as a terminal in Chromium.
Needs Python Playwright with Chromium, and ffmpeg. Usage:
  python3 scripts/loop-gif.py docs/runs/<id> docs/media/bumpproof-loop.gif
"""
import html
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
COLOURS = {31: '#ff6b6b', 32: '#5fd38d', 33: '#f2c14e', 34: '#7aa7ff', 35: '#d68fff', 36: '#5fd0d8', 90: '#8a8f98', 37: '#e6e6e6'}
SGR = re.compile(r'\x1b\[([0-9;]*)m')
WIDTH, HEIGHT = 1100, 640


def to_html(line: str) -> str:
    out, style, pos = [], {}, 0
    for m in SGR.finditer(line):
        if m.start() > pos:
            text = html.escape(line[pos:m.start()])
            css = ';'.join(f'{k}:{v}' for k, v in style.items())
            out.append(f'<span style="{css}">{text}</span>' if css else text)
        for code in [int(c or 0) for c in m.group(1).split(';')]:
            if code == 0:
                style = {}
            elif code == 1:
                style['font-weight'] = '700'
            elif code == 2:
                style['color'] = COLOURS[90]
            elif code in COLOURS:
                style['color'] = COLOURS[code]
        pos = m.end()
    out.append(html.escape(line[pos:]))
    return ''.join(out)


def page(lines: list[str]) -> str:
    font = (ROOT / 'docs/assets/fonts/ibm-plex-mono-latin-400-normal.woff2').as_uri()
    body = '\n'.join(to_html(l) for l in lines)
    return f"""<!doctype html><meta charset="utf-8"><style>
@font-face {{ font-family: Plex; src: url({font}) format('woff2'); }}
html, body {{ margin: 0; background: #16181d; }}
.bar {{ height: 30px; background: #24272e; display: flex; align-items: center; gap: 8px; padding: 0 14px;
  color: #8a8f98; font: 13px Plex, monospace; }}
.dot {{ width: 11px; height: 11px; border-radius: 50%; background: #3a3e47; }}
pre {{ margin: 0; padding: 16px 18px; color: #e6e6e6; font: 14px/1.5 Plex, monospace; white-space: pre-wrap; }}
</style><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>
<span>$ npx github:aimanmalib/bumpproof replay {html.escape(RUN)}</span></div><pre>{body}</pre>"""


def hold(line: str) -> float:
    plain = SGR.sub('', line)
    if re.search(r'failed in|writing a fix|Fix accepted|Verdict: ', plain):
        return 1.4
    return 0.45


RUN = sys.argv[1]
OUT = Path(sys.argv[2])
env = {**os.environ, 'FORCE_COLOR': '1'}
env.pop('NO_COLOR', None)
text = subprocess.run(['node', str(ROOT / 'src/cli.ts'), 'replay', RUN, '--speed', '0'], cwd=ROOT, env=env,
                      capture_output=True, text=True, check=True).stdout
lines = text.rstrip('\n').split('\n')
head = next(i for i, l in enumerate(lines) if SGR.sub('', l).strip() == '') + 1

tmp = Path(tempfile.mkdtemp(prefix='bp-gif-'))
try:
    concat = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        tab = browser.new_page(viewport={'width': WIDTH, 'height': HEIGHT})
        for n in range(head, len(lines) + 1):
            tab.set_content(page(lines[:n]))
            tab.evaluate('document.fonts.ready')
            f = tmp / f'f{n:03}.png'
            tab.screenshot(path=str(f))
            wait = 4.5 if n == len(lines) else hold(lines[n - 1]) if n > head else 1.2
            concat += [f"file '{f}'", f'duration {wait}']
        browser.close()
    concat.append(f"file '{f}'")
    (tmp / 'list.txt').write_text('\n'.join(concat) + '\n')
    OUT.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', str(tmp / 'list.txt'),
                    '-vf', 'fps=10,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=none',
                    '-loop', '0', str(OUT)], check=True)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
print(f'{OUT} {OUT.stat().st_size // 1024} KB, {len(lines) - head + 1} frames')
