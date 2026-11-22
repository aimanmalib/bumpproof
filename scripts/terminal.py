"""Draws terminal output with ANSI colours as an HTML page, for the README GIF and the video stills."""
import html
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COLOURS = {31: '#ff6b6b', 32: '#5fd38d', 33: '#f2c14e', 34: '#7aa7ff', 35: '#d68fff', 36: '#5fd0d8', 90: '#8a8f98', 37: '#e6e6e6'}
SGR = re.compile(r'\x1b\[([0-9;]*)m')


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


def page(lines: list[str], title: str) -> str:
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
<span>{html.escape(title)}</span></div><pre>{body}</pre>"""
