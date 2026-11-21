"""Export one still per Interject feature from the Desktop screen recording,
in the same look as the demo video: warm background, a title and one-line
caption, and the chat in a rounded card with orange boxes on the parts that matter.

Run (needs ffmpeg and Pillow):  python make_stills.py RAW.mov OUTDIR
Rows and boxes are in the 1400-wide chat coordinates used by the video scripts
(the chat column of the raw recording, scaled by 2/3).
"""
import os, subprocess, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

RAW, OUTDIR = sys.argv[1], sys.argv[2]
os.makedirs(OUTDIR, exist_ok=True)
K = 1.5                                   # chat coords -> native pixels
X0, X1 = 110, 1990                        # horizontal crop of the chat column (native)
M = 90                                    # outer margin
BG, INK, MUTED, ORANGE = (243, 241, 236), (28, 27, 25), (118, 113, 104), (217, 119, 87)
SF = "/System/Library/Fonts/SFNS.ttf"

def font(size, weight="Regular"):
    f = ImageFont.truetype(SF, size); f.set_variation_by_name(weight); return f

STILLS = [
    ("01-interject-here", 135.9, 664, 1262,
     "Select any line, then click Interject here",
     "The button appears above the prompt whenever text in Claude's reply is selected.",
     [(350, 676, 414, 704), (196, 1206, 370, 1246)]),
    ("02-interject-form", 141.7, 660, 986,
     "Interject at this line",
     "Ask on the side, get a quick answer, add a note to your next message, or cut here.", []),
    ("03-quick-answer", 149.0, 310, 668,
     "Quick answer",
     "A short answer without tools, in a box right under the line.", []),
    ("04-ask-on-the-side-and-follow-up", 187.0, 300, 1200,
     "Ask on the side, then follow up",
     "A side agent with full tool use answers at the line. Follow-ups sit under their box.", []),
    ("05-nested-interjection", 249.5, 278, 982,
     "Interject inside a side answer",
     "The nested question brings the earlier exchange along.", []),
    ("06-keep-and-add-to-next-message", 244.8, 560, 1262,
     "Keep, or add a note to your next message",
     "The line above the prompt counts what will go with your next message.",
     [(206, 716, 566, 744), (206, 912, 670, 940), (214, 1208, 624, 1244)]),
    ("07-cut-here-and-continue", 295.0, 170, 870,
     "Cut here and continue",
     "The rest of the reply is dropped. Claude rewrites from that line, following your note.", []),
    ("08-rewrite-follows-the-note", 353.0, 10, 720,
     "The rewrite follows your note",
     "Here, every symbol is now defined before its equation.", []),
    ("09-see-what-goes-with-next-message", 320.5, 160, 1260,
     "See what goes with your next message",
     "Click show above the prompt to see the exact text Claude will get.",
     [(200, 1208, 600, 1244)]),
    ("10-reply-uses-what-you-kept", 365.0, 100, 660,
     "Claude's reply uses what you kept",
     "The kept note asked for the Muon paper, so the reply covers it. Show reveals what was sent.",
     [(204, 272, 576, 298)]),
    ("11-fork-to-session", 440.5, 494, 1060,
     "Fork to session",
     "Turn a side chat into a session of its own. Start it from the card.",
     [(760, 990, 838, 1032)]),
]

def grab(t):
    path = os.path.join(OUTDIR, "_frame.png")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t}", "-i", RAW, "-frames:v", "1", path], check=True)
    im = Image.open(path).convert("RGB"); os.remove(path); return im

def compose(name, body, title, sub, boxes_px):
    cw, ch = body.size
    tf, sf = font(66, "Semibold"), font(38)
    head = 70 + 82 + 54 + 46
    W, H = cw + 2 * M, head + ch + M
    im = Image.new("RGB", (W, H), BG)
    # soft shadow
    sh = Image.new("L", (W, H), 0)
    ImageDraw.Draw(sh).rounded_rectangle((M + 6, head + 18, M + cw - 6, head + ch + 22), radius=34, fill=80)
    sh = sh.filter(ImageFilter.GaussianBlur(26))
    im.paste(Image.new("RGB", (W, H), (120, 110, 95)), (0, 0), sh)
    # card
    mask = Image.new("L", (cw * 2, ch * 2), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, cw * 2 - 1, ch * 2 - 1), radius=60, fill=255)
    mask = mask.resize((cw, ch), Image.LANCZOS)
    card = body.copy(); d = ImageDraw.Draw(card)
    for (x0, y0, x1, y1) in boxes_px:
        d.rounded_rectangle((x0 - 10, y0 - 10, x1 + 10, y1 + 10), radius=18, outline=ORANGE, width=8)
    im.paste(card, (M, head), mask)
    ImageDraw.Draw(im).rounded_rectangle((M, head, M + cw - 1, head + ch - 1), radius=30, outline=(222, 218, 210), width=2)
    d = ImageDraw.Draw(im)
    d.text((M, 70), title, font=tf, fill=INK)
    d.text((M, 70 + 92), sub, font=sf, fill=MUTED)
    im.save(os.path.join(OUTDIR, name + ".png"), optimize=True)
    print(name, im.size)

for name, t, top, bottom, title, sub, boxes in STILLS:
    fr = grab(t)
    col = fr.crop((1011, 170, 1011 + 2100, 170 + 2064))
    body = col.crop((X0, int(top * K), X1, int(bottom * K)))
    px = [(x0 * K - X0, (y0 - top) * K, x1 * K - X0, (y1 - top) * K) for (x0, y0, x1, y1) in boxes]
    compose(name, body, title, sub, px)

# 12: the whole window, other project names blurred, cropped to the sidebar and the reply.
fr = grab(453.0)
win = fr.crop((0, 81, 2880, 2229))
for (x0, y0, x1, y1) in [(15, 603, 645, 885), (15, 1095, 645, 1167), (15, 2073, 645, 2148)]:
    reg = win.crop((x0, y0, x1, y1))
    sm = reg.resize((max(1, reg.width // 24), max(1, reg.height // 24)))
    win.paste(sm.resize(reg.size, Image.BILINEAR).filter(ImageFilter.GaussianBlur(6)), (x0, y0))
body = win.crop((0, 560, 2880, 1840))
s = 1880 / body.width
body = body.resize((1880, round(body.height * s)), Image.LANCZOS)
px = [((x0) * s, (y0 - 560) * s, (x1) * s, (y1 - 560) * s) for (x0, y0, x1, y1) in [(15, 960, 645, 1095), (1320, 1497, 2670, 1761)]]
compose("12-fork-is-its-own-session", body, "The fork is a session of its own",
        "It sits under the original session in the sidebar, and the original hears back from it.", px)
