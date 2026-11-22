#!/usr/bin/env python3
"""Renders `bumpproof replay <run>` as an animated GIF for the README.

The frames are the real replay output of a recorded run (colours included), drawn as a terminal in Chromium.
Needs Python Playwright with Chromium, and ffmpeg. Usage:
  python3 scripts/loop-gif.py docs/runs/<id> docs/media/bumpproof-loop.gif
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

from terminal import SGR, page


def hold(line: str) -> float:
    plain = SGR.sub('', line)
    if re.search(r'failed in|writing a fix|Fix accepted|Verdict: ', plain):
        return 1.4
    return 0.45


ROOT = Path(__file__).resolve().parent.parent
WIDTH, HEIGHT = 1100, 640
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
            tab.set_content(page(lines[:n], f'$ npx github:aimanmalib/bumpproof replay {RUN}'))
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
