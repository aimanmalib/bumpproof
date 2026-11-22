#!/usr/bin/env python3
"""Renders the demo video from real stills, a narration folder and scripts/video/timeline.json.

  python3 scripts/video-render.py SHOTS VOICE OUT.mp4            full render (frames, audio, mux)
  python3 scripts/video-render.py SHOTS VOICE SHEET.jpg --stills 0,12.5,40   contact sheet of single frames
  python3 scripts/video-render.py SHOTS VOICE OUT.srt --srt      the burned-in captions as a subtitle file

SHOTS = folder of PNG stills (scripts/video-shots.py). VOICE = folder with skrip.json ({"baris": [{"id", "sari"}]}) and
work/suara/<id>.mp3 + <id>.json (text and per-character timings). Every frame is a pure function of time, so a frame
can be rendered alone and the result does not depend on machine load.
"""
import json
import re
import subprocess
import sys
from functools import lru_cache
from multiprocessing import Pool
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
TL = json.loads((ROOT / 'scripts/video/timeline.json').read_text())
W, H = TL['size']
FPS = TL['fps']
C = TL['colours']
FONTS = {'display': 'ibm-plex-sans-condensed-latin-700-normal', 'sans': 'ibm-plex-sans-latin-400-normal',
         'sans_bold': 'ibm-plex-sans-latin-600-normal', 'mono': 'ibm-plex-mono-latin-400-normal'}
STATE = {}


@lru_cache(maxsize=64)
def font(kind: str, size: int):
    return ImageFont.truetype(str(ROOT / f'docs/assets/fonts/{FONTS[kind]}.woff2'), size)


def rgb(name: str, a: int = 255):
    h = C.get(name, name).lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) + (a,)


def ease(x: float) -> float:
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


def ffprobe(path: Path) -> float:
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)],
                         capture_output=True, text=True, check=True).stdout
    return float(out)


# ---------- plan: scene times, voice start times, caption chunks ----------
def chunks(text: str, limit: int) -> list[str]:
    parts = [p for p in re.split(r'(?<=[.!?])\s+(?=["A-Z0-9])', text.strip()) if p]
    out = []
    for p in parts:
        while len(p) > limit:
            cut = max(p.rfind(sep, 0, limit) for sep in (': ', ', ', '; '))
            if cut < 20:
                cut = p.rfind(' ', 0, limit)
            out.append(p[:cut + 1].strip())
            p = p[cut + 1:].strip()
        out.append(p)
    return out


def plan(voice: Path) -> dict:
    lines = {b['id']: b['sari'] for b in json.loads((voice / 'skrip.json').read_text())['baris']}
    t, scenes, caps, clips = 0.0, [], [], []
    limit = TL['caption']['max_chars']
    for sc in TL['scenes']:
        meta = json.loads((voice / f"work/suara/{sc['id']}.json").read_text())
        mp3 = voice / f"work/suara/{sc['id']}.mp3"
        dur_v = ffprobe(mp3)
        lead, tail = sc.get('lead', TL['lead']), sc.get('tail', TL['tail'])
        dur = lead + dur_v + tail + (TL['end_hold'] if sc is TL['scenes'][-1] else 0)
        v0 = t + lead
        clips.append((str(mp3), v0))
        said, al = meta['teks'], meta['al']
        shown, spoken = chunks(lines[sc['id']], limit), chunks(said, limit)
        starts = []
        if len(shown) == len(spoken):
            pos = 0
            for sp in spoken:
                i = said.index(sp, pos)
                j = i + len(sp) - 1
                starts.append((v0 + al['character_start_times_seconds'][i], v0 + al['character_end_times_seconds'][j]))
                pos = j + 1
        else:  # spoken text differs in shape: spread captions by length
            total, acc = sum(len(s) for s in shown), 0
            for s in shown:
                starts.append((v0 + dur_v * acc / total, v0 + dur_v * (acc + len(s)) / total))
                acc += len(s)
        sc_caps = [{'text': s, 't0': a, 't1': b} for s, (a, b) in zip(shown, starts)]
        for k, cp in enumerate(sc_caps):
            nxt = sc_caps[k + 1]['t0'] if k + 1 < len(sc_caps) else cp['t1'] + 0.6
            cp['t0'], cp['t1'] = cp['t0'] - 0.08, max(nxt - 0.02, cp['t1'])
        if sc.get('captions', True):
            caps += sc_caps
        shots, rest = [], dur - sum(s.get('dur', 0) for s in sc['shots'])
        s0 = t
        for s in sc['shots']:
            d = s.get('dur', rest)
            shots.append({**s, 't0': s0, 't1': s0 + d})
            s0 += d
        scenes.append({**sc, 't0': t, 't1': t + dur, 'shots': shots, 'chunk_t': [c['t0'] for c in sc_caps]})
        t += dur
    return {'scenes': scenes, 'captions': caps, 'clips': clips, 'duration': t}


# ---------- drawing ----------
@lru_cache(maxsize=3)
def still(name: str) -> Image.Image:
    return Image.open(STATE['shots'] / name).convert('RGB')


def camera(img: Image.Image, cam: list) -> tuple:
    cx, cy, w = cam
    w = min(w, img.width, img.height * W / H)
    h = w * H / W
    x0 = min(max(cx - w / 2, 0), img.width - w)
    y0 = min(max(cy - h / 2, 0), img.height - h)
    return x0, y0, w, h


def rounded(d: ImageDraw.ImageDraw, box, r, **kw):
    d.rounded_rectangle([round(v) for v in box], radius=r, **kw)


def draw_image_shot(s: dict, lt: float) -> Image.Image:
    img = still(s['img'])
    dur = s['t1'] - s['t0']
    a, b = s.get('move', [0.0, 1.0])
    k = ease((lt / dur - a) / max(b - a, 1e-6))
    cam = [f + (t - f) * k for f, t in zip(s['from'], s['to'])]
    x0, y0, w, h = camera(img, cam)
    frame = img.resize((W, H), Image.BILINEAR, box=(x0, y0, x0 + w, y0 + h))
    sc = W / w
    hl = TL['highlight']
    for item in s.get('hl', []):
        t0, t1 = item.get('t0', 0.0), item.get('t1', dur + 1)
        if not t0 <= lt < t1:
            continue
        alpha = (1.0 if t0 < 0 else ease((lt - t0) / hl['fade'])) * (1 - ease((lt - t1 + hl['fade']) / hl['fade']) if t1 <= dur else 1)
        bx = [(item['box'][0] - x0) * sc, (item['box'][1] - y0) * sc, (item['box'][2] - x0) * sc, (item['box'][3] - y0) * sc]
        layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        if item.get('spot', True):
            mask = Image.new('L', (W, H), int(255 * hl['dim'] * alpha))
            ImageDraw.Draw(mask).rounded_rectangle([round(v) for v in bx], radius=14, fill=0)
            layer.paste((0, 0, 0, 255), mask=mask)
        rounded(d, [bx[0] - 6, bx[1] - 6, bx[2] + 6, bx[3] + 6], 16, outline=rgb(hl['colour'], int(255 * alpha)), width=hl['width'])
        frame = Image.alpha_composite(frame.convert('RGBA'), layer).convert('RGB')
    return frame


SYMBOLS = set('✓✗│→…')


@lru_cache(maxsize=8)
def symbol_font(size: int):
    return ImageFont.truetype(TL['symbol_font'], size)


def mono_text(d: ImageDraw.ImageDraw, xy, text: str, size: int, fill):
    """Plex Mono has no check marks or box lines; those characters are drawn with the symbol font in the same cell."""
    x, y = xy
    f, cell = font('mono', size), font('mono', size).getlength('M')
    for ch in text:
        if ch in SYMBOLS:
            sf = symbol_font(size)
            d.text((x + (cell - sf.getlength(ch)) / 2, y), ch, font=sf, fill=fill)
        else:
            d.text((x, y), ch, font=f, fill=fill)
        x += cell


def mono_rows(s: dict) -> list:
    """Lines of a text file as (text, colour, marked) rows, wrapped to the panel width with a hanging indent."""
    lines = (STATE['shots'] / s['file']).read_text(encoding='utf-8').rstrip('\n').split('\n')
    a, b = s.get('lines', [1, len(lines)])
    cols = int(s['w'] // font('mono', s['size']).getlength('M')) - 2
    rows = []
    for k, ln in enumerate(lines[a - 1:b], a):
        mark = bool(s.get('mark')) and ln.startswith(s['mark'])
        colour = next((c for pre, c in s.get('colours', []) if ln.lstrip().startswith(pre)), 'code_ink')
        indent = ' ' * min(len(ln) - len(ln.lstrip()) + s.get('hang', 2), 24)
        first = True
        while True:
            room = cols if first else cols - len(indent)
            cut = len(ln) if len(ln) <= room else (ln.rfind(' ', 0, room) if ln.rfind(' ', 0, room) > room // 2 else room)
            rows.append(((ln[:cut] if first else indent + ln[:cut]), colour, mark, k))
            ln, first = ln[cut:].lstrip(), False
            if not ln:
                break
    return rows


def draw_mono(s: dict, lt: float) -> Image.Image:
    """A text file drawn as a terminal or code panel. `reveal` [n0, n1] = how many source lines show at the start and the
    end of the shot (the rest appear one by one, like output arriving); the panel scrolls to keep the newest line in view."""
    frame = Image.new('RGB', (W, H), rgb(s.get('bg', 'paper'))[:3])
    d = ImageDraw.Draw(frame)
    x, y, w, h = s['box']
    rounded(d, [x, y, x + w, y + h], 20, fill=rgb('ink'))
    d.text((x + 28, y + 16), s['title'], font=font('mono', 22), fill=rgb('grey'))
    rows = mono_rows({**s, 'w': w - 56})
    if 'reveal' in s:
        n0, n1 = s['reveal']
        shown = n0 + int((n1 - n0) * min(lt / max(s['t1'] - s['t0'] - 0.8, 0.1), 1.0))
        first = rows[0][3]
        rows = [r for r in rows if r[3] - first < shown]
    lh = round(s['size'] * 1.45)
    fit = int((h - 80) // lh)
    rows = rows[-fit:]
    yy = y + 64
    for text, colour, mark, _ in rows:
        if mark:
            d.rectangle([x + 8, yy - 4, x + w - 8, yy + lh - 4], fill=rgb('mark_bg'))
            d.rectangle([x + 8, yy - 4, x + 14, yy + lh - 4], fill=rgb('amber'))
        mono_text(d, (x + 28, yy), text, s['size'], rgb(colour))
        yy += lh
    return frame


def text_w(f, t: str) -> float:
    return f.getlength(t)


def draw_card(scene: dict, s: dict, t: float) -> Image.Image:
    card = s['card']
    frame = Image.new('RGB', (W, H), rgb(card['bg'])[:3])
    d = ImageDraw.Draw(frame)
    rows, y = [], 0
    for ln in card['lines']:
        f = font(ln['font'], ln['size'])
        y += ln.get('gap', 0)
        lh = round(ln['size'] * 1.18)
        rows.append((ln, f, y, lh))
        y += lh
    top = (H - y) / 2 - 20
    ct = scene['chunk_t']
    for ln, f, yy, lh in rows:
        c = ln.get('chunk', 0)
        start = ct[c] if c < len(ct) else scene['t0']
        alpha = 1.0 if c == 0 else ease((t - start) / 0.35)
        if alpha <= 0:
            continue
        x = 180
        if ln.get('logo'):
            logo = STATE['logo'].resize((lh, lh), Image.LANCZOS)
            frame.paste(logo, (x, round(top + yy)), logo)
            x += lh + 36
        col = rgb(ln['colour'])[:3]
        if alpha < 1:
            bg = rgb(card['bg'])[:3]
            col = tuple(round(b + (c2 - b) * alpha) for b, c2 in zip(bg, col))
        d.text((x, top + yy + lh * 0.08), ln['t'], font=f, fill=col)
    return frame


def overlay(frame: Image.Image, o: dict, lt: float, scene_dur: float) -> Image.Image:
    t0, t1 = o.get('t0', 0.0), o.get('t1', scene_dur + 1)
    if not t0 <= lt < t1:
        return frame
    alpha = ease((lt - t0) / 0.3) if t0 > 0 else 1.0
    if t1 <= scene_dur:
        alpha *= 1 - ease((lt - t1 + 0.3) / 0.3)
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x, y = o['xy']
    if o['type'] == 'tag':
        f = font('sans_bold', 30)
        tw = text_w(f, o['text'])
        rounded(d, [x, y, x + tw + 44, y + 58], 29, fill=rgb(o['colour']))
        d.text((x + 22, y + 9), o['text'], font=f, fill=rgb('white'))
    elif o['type'] == 'panel':
        f = font(o['font'], o['size'])
        lh = round(o['size'] * 1.45)
        title_h = 56 if o.get('title') else 0
        hgt = 40 + title_h + lh * len(o['lines'])
        rounded(d, [x, y, x + o['w'], y + hgt], 18, fill=rgb('ink', 238), outline=rgb('grey', 120), width=2)
        yy = y + 22
        if o.get('title'):
            d.text((x + 28, yy), o['title'], font=font('mono', 22), fill=rgb('grey'))
            yy += title_h
        for text, col in o['lines']:
            d.text((x + 28, yy), text, font=f, fill=rgb(col))
            yy += lh
    elif o['type'] == 'inset':
        img = still(o['img'])
        if o.get('crop'):
            img = img.crop(tuple(o['crop']))
        h = round(o['w'] * img.height / img.width)
        thumb = img.resize((o['w'], h), Image.BILINEAR)
        rounded(d, [x - 14, y - 70, x + o['w'] + 14, y + h + 14], 18, fill=rgb('ink', 245))
        d.text((x, y - 56), o['label'], font=font('sans_bold', 28), fill=rgb('white'))
        layer.paste(thumb, (x, y))
        f = font('sans_bold', 26)
        tw = text_w(f, o['tag'])
        rounded(d, [x + o['w'] - tw - 40, y - 60, x + o['w'], y - 14], 23, fill=rgb(o['tag_colour']))
        d.text((x + o['w'] - tw - 20, y - 55), o['tag'], font=f, fill=rgb('white'))
    if alpha < 1:
        layer.putalpha(layer.getchannel('A').point(lambda v: round(v * alpha)))
    return Image.alpha_composite(frame.convert('RGBA'), layer).convert('RGB')


def caption(frame: Image.Image, t: float) -> Image.Image:
    cur = [c for c in STATE['plan']['captions'] if c['t0'] <= t < c['t1']]
    if not cur:
        return frame
    cfg = TL['caption']
    f = font('sans_bold', cfg['size'])
    text = cur[-1]['text']
    tw = text_w(f, text)
    pad_x, ph = 30, round(cfg['size'] * 1.7)
    x0, y1 = (W - tw) / 2 - pad_x, H - cfg['bottom']
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    rounded(d, [x0, y1 - ph, x0 + tw + 2 * pad_x, y1], ph // 2, fill=rgb('ink', 222))
    d.text((x0 + pad_x, y1 - ph + (ph - cfg['size'] * 1.3) / 2), text, font=f, fill=rgb('white'))
    return Image.alpha_composite(frame.convert('RGBA'), layer).convert('RGB')


def shot_frame(scene: dict, s: dict, t: float) -> Image.Image:
    lt = t - s['t0']
    if 'card' in s:
        frame = draw_card(scene, s, t)
    elif 'file' in s:
        frame = draw_mono(s, min(lt, s['t1'] - s['t0']))
    else:
        frame = draw_image_shot(s, min(lt, s['t1'] - s['t0']))
    for o in scene.get('overlays', []):
        frame = overlay(frame, o, t - scene['t0'], scene['t1'] - scene['t0'])
    return frame


def render(t: float) -> Image.Image:
    flat = [(sc, s) for sc in STATE['plan']['scenes'] for s in sc['shots']]
    i = next((k for k, (sc, s) in enumerate(flat) if s['t0'] <= t < s['t1']), len(flat) - 1)
    sc, s = flat[i]
    frame = shot_frame(sc, s, t)
    xf = TL['crossfade']
    if i > 0 and t - s['t0'] < xf:
        psc, ps = flat[i - 1]
        frame = Image.blend(shot_frame(psc, ps, ps['t1'] - 1e-3), frame, ease((t - s['t0']) / xf))
    return caption(frame, t)


def init(shots: str, voice: str):
    STATE['shots'] = Path(shots)
    STATE['plan'] = plan(Path(voice))
    STATE['logo'] = Image.open(ROOT / 'brand/logo-512.png').convert('RGBA')


def frame_bytes(n: int) -> bytes:
    return render(n / FPS).tobytes()


# ---------- audio ----------
def audio(clips: list, dur: float, out: Path):
    """Places each narration clip at its start time, then normalises to -16.5 LUFS, true peak -2 dBTP (two passes)."""
    args, parts = ['ffmpeg', '-y', '-v', 'error'], []
    for k, (mp3, t0) in enumerate(clips):
        args += ['-i', mp3]
        ms = round(t0 * 1000)
        parts.append(f'[{k}:a]aresample=48000,aformat=channel_layouts=mono,adelay={ms}:all=1[a{k}]')
    mix = ''.join(f'[a{k}]' for k in range(len(clips)))
    graph = ';'.join(parts) + f';{mix}amix=inputs={len(clips)}:normalize=0,apad,atrim=0:{dur:.3f}[m]'
    raw = out.with_suffix('.raw.wav')
    subprocess.run(args + ['-filter_complex', graph, '-map', '[m]', '-ar', '48000', str(raw)], check=True)
    target = 'I=-16.5:TP=-2.0:LRA=11'
    log = subprocess.run(['ffmpeg', '-hide_banner', '-i', str(raw), '-af', f'loudnorm={target}:print_format=json', '-f', 'null', '-'],
                         capture_output=True, text=True).stderr
    m = json.loads(log[log.rindex('{'):log.rindex('}') + 1])
    second = (f"loudnorm={target}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
              f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', str(raw), '-af', second, '-ar', '48000', str(out)], check=True)
    raw.unlink()


def srt_time(t: float) -> str:
    ms = round(t * 1000)
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def srt(caps: list) -> str:
    """The same caption chunks and times the frames show, as SubRip text. The frames switch to the next chunk as soon as
    it starts, so each end is cut at the next start; otherwise a player would stack two lines."""
    ends = [min(c['t1'], n['t0']) for c, n in zip(caps, caps[1:])] + [caps[-1]['t1']] if caps else []
    return ''.join(f"{k}\n{srt_time(c['t0'])} --> {srt_time(e)}\n{c['text']}\n\n"
                   for k, (c, e) in enumerate(zip(caps, ends), 1))


def main(argv: list[str]):
    if len(argv) < 3:
        sys.exit(__doc__)
    shots, voice, out = argv[0], argv[1], Path(argv[2])
    init(shots, voice)
    p = STATE['plan']
    print(f"duration {p['duration']:.2f} s, {len(p['scenes'])} scenes, {len(p['captions'])} captions")
    if '--srt' in argv:
        out.write_text(srt(p['captions']), encoding='utf-8')
        print(f'wrote {out}')
        return
    if '--stills' in argv:
        times = [float(x) for x in argv[argv.index('--stills') + 1].split(',')]
        tw, th = W // 3, H // 3
        sheet = Image.new('RGB', (tw * 3, (th + 24) * ((len(times) + 2) // 3)), 'white')
        d = ImageDraw.Draw(sheet)
        for k, t in enumerate(times):
            x, y = (k % 3) * tw, (k // 3) * (th + 24)
            sheet.paste(render(t).resize((tw, th), Image.LANCZOS), (x, y + 24))
            d.text((x + 6, y + 4), f't={t:.2f}', fill='black', font=font('mono', 16))
        sheet.save(out, quality=88)
        return
    wav = out.with_suffix('.wav')
    audio(p['clips'], p['duration'], wav)
    n = round(p['duration'] * FPS)
    enc = subprocess.Popen(['ffmpeg', '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS),
                            '-i', '-', '-i', str(wav), '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p',
                            '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', str(out)], stdin=subprocess.PIPE)
    workers = int(next((a.split('=')[1] for a in argv if a.startswith('--workers=')), '3'))
    with Pool(workers, initializer=init, initargs=(shots, voice)) as pool:
        for k, data in enumerate(pool.imap(frame_bytes, range(n), chunksize=6)):
            enc.stdin.write(data)
            if k % 900 == 0:
                print(f'frame {k}/{n}', flush=True)
    enc.stdin.close()
    if enc.wait() != 0:
        sys.exit('ffmpeg failed')
    wav.unlink()
    print(f'wrote {out}')


if __name__ == '__main__':
    main(sys.argv[1:])
