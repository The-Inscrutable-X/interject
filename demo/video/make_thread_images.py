"""Make 16:9 pictures for a social thread from the Desktop screen recording.

Each picture is a tight crop of the chat (so text stays readable on a phone),
on the demo's warm background, with orange boxes on the parts that matter.
16:9 pictures are shown uncropped in X's timeline.

Run (needs ffmpeg and Pillow):  python make_thread_images.py RAW.mov OUTDIR
Crops and boxes are in the chat column's own pixels (2100 wide); `rows` uses
the 1400-wide coordinates of the other scripts.
"""
import os, subprocess, sys
from PIL import Image, ImageDraw, ImageFilter

RAW, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
W, H, PAD = 1600, 900, 36
BG, ORANGE = (243, 241, 236), (217, 119, 87)
K = 1.5

def C(*v): return tuple(round(K * a) for a in v)

# name, raw time, crop top (column px), crop width, centre x, boxes (column px)
SHOTS = [
    ("1-interject-here", 135.9, 905, 1840, 1050, [C(350, 676, 414, 704), C(196, 1206, 370, 1246)]),
    ("2-answer-stays-at-the-line", 149.0, 230, 1840, 1050, []),
    ("3-four-choices", 141.7, 700, 1840, 1050, []),
    ("4-side-answer-and-follow-up", 187.0, 440, 1840, 1050, []),
    ("5-nested", 249.5, 425, 1840, 1050, []),
    ("6-keep", 244.8, 876, 1840, 1050, [(330, 1075, 830, 1110), (330, 1372, 870, 1406), (300, 1820, 905, 1860)]),
    ("7-see-what-is-sent", 320.5, 228, 1840, 1050, []),
    ("8-cut", 295.0, 262, 1840, 1050, []),
    ("9-rewrite", 353.0, 20, 1840, 1050, []),
]

def grab(t):
    p = os.path.join(OUT, "_f.png")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t}", "-i", RAW, "-frames:v", "1", p], check=True)
    im = Image.open(p).convert("RGB"); os.remove(p); return im

def frame_it(body, boxes, name):
    iw, ih = W - 2 * PAD, H - 2 * PAD
    s = iw / body.width
    body = body.resize((iw, round(body.height * s)), Image.LANCZOS).crop((0, 0, iw, ih))
    d = ImageDraw.Draw(body)
    for (x0, y0, x1, y1) in boxes:
        d.rounded_rectangle((x0 * s - 8, y0 * s - 8, x1 * s + 8, y1 * s + 8), radius=12, outline=ORANGE, width=5)
    canvas = Image.new("RGB", (W, H), BG)
    sh = Image.new("L", (W, H), 0)
    ImageDraw.Draw(sh).rounded_rectangle((PAD + 4, PAD + 10, W - PAD - 4, H - PAD + 12), radius=22, fill=70)
    canvas.paste(Image.new("RGB", (W, H), (120, 110, 95)), (0, 0), sh.filter(ImageFilter.GaussianBlur(16)))
    m = Image.new("L", (iw * 2, ih * 2), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, iw * 2 - 1, ih * 2 - 1), radius=36, fill=255)
    canvas.paste(body, (PAD, PAD), m.resize((iw, ih), Image.LANCZOS))
    canvas.save(os.path.join(OUT, name + ".jpg"), quality=90, optimize=True)
    print(name)

for name, t, top, width, cx, boxes in SHOTS:
    col = grab(t).crop((1011, 170, 1011 + 2100, 170 + 2064))
    h = round(width * (H - 2 * PAD) / (W - 2 * PAD))
    x0 = cx - width // 2
    body = Image.new("RGB", (width, h), (254, 254, 254))
    body.paste(col.crop((max(0, x0), top, min(2100, x0 + width), min(2064, top + h))), (max(0, -x0), 0))
    frame_it(body, [(a - x0, b - top, c - x0, d - top) for (a, b, c, d) in boxes], name)

# The fork: the whole window, with other project names blurred.
win = grab(453.0).crop((0, 81, 2880, 2229))
for (x0, y0, x1, y1) in [(15, 603, 645, 885), (15, 1095, 645, 1167), (15, 2073, 645, 2148)]:
    reg = win.crop((x0, y0, x1, y1))
    sm = reg.resize((max(1, reg.width // 24), max(1, reg.height // 24)))
    win.paste(sm.resize(reg.size, Image.BILINEAR).filter(ImageFilter.GaussianBlur(6)), (x0, y0))
wx0, wy0, ww = 0, 560, 2760
wh = round(ww * (H - 2 * PAD) / (W - 2 * PAD))
frame_it(win.crop((wx0, wy0, wx0 + ww, wy0 + wh)),
         [(15, 960 - wy0, 645, 1095 - wy0), (1320, 1497 - wy0, 2670, 1761 - wy0)], "10-fork")
