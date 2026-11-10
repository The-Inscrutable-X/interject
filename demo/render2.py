"""Cast -> captioned MP4, drawing each frame from pyte's screen with Pillow.

Usage: venv/bin/python render2.py <in.cast> <out.mp4> <log with snapshot times>
"""
import json, re, subprocess, sys

import pyte
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

SRC, OUT = sys.argv[1], sys.argv[2]
START, IDLE, TAIL, FPS = 2.8, 1.1, 3.0, 12
SIZE = 17
MENLO = '/System/Library/Fonts/Menlo.ttc'
FALLBACKS = ['/System/Library/Fonts/Apple Symbols.ttf', '/System/Library/Fonts/Supplemental/Arial Unicode.ttf']

# ---- fonts, with per-character fallback
fonts = {}
def font(path, bold=False, size=SIZE):
    key = (path, bold, size)
    if key not in fonts:
        fonts[key] = ImageFont.truetype(path, size, index=1 if (bold and path.endswith('.ttc')) else 0)
    return fonts[key]

cmaps = {}
def has(path, ch):
    if path not in cmaps:
        tt = TTFont(path, fontNumber=0)
        cmaps[path] = set(tt.getBestCmap().keys())
    return ord(ch) in cmaps[path]

def font_for(ch, bold=False, size=SIZE):
    if has(MENLO, ch):
        return font(MENLO, bold, size)
    for p in FALLBACKS:
        if has(p, ch):
            return font(p, False, size)
    return font(MENLO, bold, size)

base = font(MENLO)
CW = round(base.getlength('M'))
CH = round(SIZE * 1.32)

# ---- colours
BG, FG = (30, 31, 34), (220, 221, 222)
NAMED = {
    'black': (40, 42, 46), 'red': (224, 108, 117), 'green': (152, 195, 121), 'brown': (229, 192, 123),
    'yellow': (229, 192, 123), 'blue': (97, 175, 239), 'magenta': (198, 120, 221), 'cyan': (86, 182, 194),
    'white': (220, 223, 228), 'brightblack': (110, 115, 125), 'brightred': (240, 130, 140),
    'brightgreen': (170, 215, 140), 'brightyellow': (240, 210, 140), 'brightblue': (130, 195, 250),
    'brightmagenta': (215, 145, 235), 'brightcyan': (110, 205, 215), 'brightwhite': (255, 255, 255),
}
def color(c, default):
    if c == 'default':
        return default
    if c in NAMED:
        return NAMED[c]
    if re.fullmatch(r'[0-9a-fA-F]{6}', c):
        return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))
    return default

# ---- the cast, trimmed and idle-capped (as render.py)
lines = open(SRC).read().splitlines()
header, events = json.loads(lines[0]), [json.loads(l) for l in lines[1:]]
COLS, ROWS = header['width'], header['height']
timeline, new_t, prev = [], 0.0, START
pre = ''.join(e[2] for e in events if e[0] < START)
mapped = []
for t, kind, data in events:
    if t < START:
        continue
    new_t += min(t - prev, IDLE)
    prev = t
    timeline.append((new_t, data))
    mapped.append((t, new_t))

def at(t):
    if t <= START:
        return 0.0
    lo, ln = START, 0.0
    for o, n in mapped:
        if o > t:
            break
        lo, ln = o, n
    return ln + min(t - lo, IDLE)

CAPTIONS = [
    (2.8, 15.6, 'Claude Code with the interject mod: a normal reply'),
    (15.6, 27.6, '1  Select a line, click Interject here, ask on the side: answered in a box at that line'),
    (27.6, 39.6, '2  Nesting: select a line of the side answer and interject again (Quick answer, no tools)'),
    (39.6, 44.4, '3  keep: that side answer will go with your next message'),
    (44.4, 51.8, '4  Add to my next message: a note at line 5, attached when you next send'),
    (51.8, 1e9, '5  Cut here and continue: the reply after line 3 is withdrawn; Claude answers and goes on'),
]
caps = [(at(a), at(b) if b < 1e9 else 1e9, text) for a, b, text in CAPTIONS]

BAR = 52
PAD = 14
W = COLS * CW + PAD * 2
H = ROWS * CH + PAD * 2 + BAR
W += W % 2
H += H % 2

screen = pyte.Screen(COLS, ROWS)
stream = pyte.Stream(screen)
stream.feed(pre)

def draw_frame(t):
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)
    # caption bar
    d.rectangle([0, 0, W, BAR], fill=(18, 18, 20))
    text = next((c for a, b, c in caps if a <= t < b), '')
    x = 18
    for ch in text:
        f = font_for(ch, True, 19) if not has(MENLO, ch) else ImageFont.truetype('/System/Library/Fonts/SFNS.ttf', 19)
        d.text((x, (BAR - 22) // 2), ch, font=f, fill=(250, 204, 21))
        x += f.getlength(ch)
    # cells
    for y in range(ROWS):
        row = screen.buffer[y]
        for xcell in range(COLS):
            c = row[xcell]
            fg, bg = color(c.fg, FG), color(c.bg, BG)
            if c.reverse:
                fg, bg = bg, fg
            px, py = PAD + xcell * CW, BAR + PAD + y * CH
            if bg != BG:
                d.rectangle([px, py, px + CW - 1, py + CH - 1], fill=bg)
            ch = {'⏺': '●', '⏵': '▶', '⎿': '└'}.get(c.data, c.data)
            if ch and ch != ' ':
                f = font_for(ch, c.bold)
                if c.italics is False and False:
                    pass
                fill = tuple(int(v * 0.62 + BG[i] * 0.38) for i, v in enumerate(fg)) if getattr(c, 'dim', False) else fg
                d.text((px, py + 2), ch, font=f, fill=fill)
    return img

total = timeline[-1][0] + TAIL
ff = subprocess.Popen(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
                       '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-', '-c:v', 'libx264', '-crf', '18',
                       '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT], stdin=subprocess.PIPE)
i, last_key, last_img = 0, None, None
n = int(total * FPS) + 1
for k in range(n):
    t = k / FPS
    changed = False
    while i < len(timeline) and timeline[i][0] <= t:
        stream.feed(timeline[i][1])
        i += 1
        changed = True
    cap = next((c for a, b, c in caps if a <= t < b), '')
    key = (i, cap)
    if key != last_key or last_img is None:
        last_img = draw_frame(t)
        last_key = key
    ff.stdin.write(last_img.tobytes())
ff.stdin.close()
ff.wait()
print('frames', n, 'seconds', round(total, 1), 'size', W, H)
