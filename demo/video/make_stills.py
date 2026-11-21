"""Export one still per Interject feature from the Desktop screen recording,
in the same look as the demo video: warm background, a title and one-line
caption, and the chat in a rounded card with orange boxes on the parts that matter.

Most stills also show what you click to get that result: a "You click" strip
under the caption, cut from the real form or button row at the moment of the
click, with an orange box on the button.

Run (needs ffmpeg and Pillow):  python make_stills.py RAW.mov OUTDIR
Card rows and card boxes are in the 1400-wide chat coordinates used by the video
scripts (the chat column of the raw recording, scaled by 2/3). Click strips are
in native column pixels (the 2100-wide chat column of the raw recording).
"""
import os, subprocess, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

RAW, OUTDIR = sys.argv[1], sys.argv[2]
os.makedirs(OUTDIR, exist_ok=True)
K = 1.5                                   # chat coords -> native pixels
X0, X1 = 110, 1990                        # horizontal crop of the chat column (native)
M = 90                                    # outer margin
BG, INK, MUTED, ORANGE = (243, 241, 236), (28, 27, 25), (118, 113, 104), (217, 119, 87)
EDGE = (222, 218, 210)
SF = "/System/Library/Fonts/SFNS.ttf"
COL = (1011, 170, 1011 + 2100, 170 + 2064)  # the chat column in the raw recording

def font(size, weight="Regular"):
    f = ImageFont.truetype(SF, size); f.set_variation_by_name(weight); return f

# Click strips: (raw time, crop of the column, [clicked buttons]), all in native column px.
CLICK = {
    "interject_here": (135.9, (276, 1804, 700, 1878), [(292, 1814, 554, 1866)]),
    "quick_answer":   (141.6, (318, 1304, 1712, 1382), [(600, 1316, 958, 1370)]),
    "ask_side":       (163.9, (318, 1404, 1712, 1484), [(332, 1416, 588, 1472)]),
    "follow_up":      (173.4, (314, 1525, 1010, 1586), [(328, 1531, 482, 1576)]),
    "nested_here":    (200.5, (280, 1806, 1090, 1880), [(298, 1818, 548, 1868)]),
    "add_next":       (240.7, (950, 1450, 1360, 1530), [(972, 1462, 1340, 1518)]),
    "keep":           (244.4, (314, 1066, 1010, 1128), [(510, 1072, 604, 1116)]),
    "cut":            (290.0, (318, 1060, 1712, 1134), [(1358, 1068, 1694, 1124)]),
    "show":           (317.5, (276, 1804, 930, 1876), [(824, 1816, 906, 1866)]),
    "send":           (336.0, (276, 1890, 1824, 2002), [(1672, 1912, 1734, 1972)]),
    "fork":           (436.0, (314, 1306, 1010, 1366), [(636, 1312, 850, 1358)]),
    "start":          (441.4, (318, 1474, 1292, 1562), [(1146, 1488, 1256, 1546)]),
}

# name, raw time, card top, card bottom (chat coords), title, caption, card boxes, click strip
# A click strip is a list of CLICK keys with "then" / "or" between them.
STILLS = [
    ("01-interject-here", 135.9, 664, 1262,
     "Select any line, then click Interject here",
     "The button appears above the prompt whenever text in Claude's reply is selected.",
     [(350, 676, 414, 704), (196, 1206, 370, 1246)], []),
    ("02-interject-form", 141.7, 660, 986,
     "Interject at this line",
     "Ask on the side, get a quick answer, add a note to your next message, or cut here.",
     [], ["interject_here"]),
    ("03-quick-answer", 149.0, 310, 668,
     "Quick answer",
     "A short answer without tools, in a box right under the line.",
     [], ["quick_answer"]),
    ("04-ask-on-the-side", 171.0, 548, 1082,
     "Ask on the side",
     "An agent with your whole conversation and full tool use answers at the line.",
     [], ["ask_side"]),
    ("05-cut-here-and-continue", 295.0, 170, 870,
     "Cut here and continue",
     "The rest of the reply is dropped. Claude rewrites from that line, following your note.",
     [(575, 266.5, 1160, 289), (221, 294.5, 375, 316.5)],   # "Before every equation ... symbols means."
     ["cut"]),
    ("06-rewrite-follows-the-note", 353.0, 10, 720,
     "The rewrite follows your note",
     "Here, every symbol is now defined before its equation.",
     [], ["cut"]),
    ("07-follow-up", 187.0, 716, 1200,
     "Follow up on any box",
     "The follow-up sits right under the box that it follows.",
     [], ["follow_up"]),
    ("08-nested-interjection", 249.5, 278, 982,
     "Interject inside a side answer",
     "The nested question brings the earlier exchange along.",
     [], ["nested_here"]),
    ("09-keep-and-add-to-next-message", 244.8, 560, 1262,
     "Keep, or add a note to your next message",
     "The line above the prompt counts what will go with your next message.",
     [(206, 716, 566, 744), (206, 912, 670, 940), (214, 1208, 624, 1244)],
     ["add_next", "or", "keep"]),
    ("10-see-what-goes-with-next-message", 320.5, 166, 1260,
     "See what goes with your next message",
     "The exact text that Claude will get with your message.",
     [], ["show"]),
    ("11-reply-uses-what-you-kept", 365.0, 100, 660,
     "Claude's reply uses what you kept",
     "The kept note asked for the Muon paper, so the reply covers it. Show reveals what was sent.",
     [(204, 272, 576, 298)], ["send"]),
    ("12-fork-to-session", 440.5, 494, 1060,
     "Fork to session",
     "Turn a side chat into a session of its own. Start it from the card.",
     [], ["fork"]),
]

_frames = {}
def grab(t):
    if t not in _frames:
        path = os.path.join(OUTDIR, "_frame.png")
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-ss", f"{t}", "-i", RAW,
                        "-frames:v", "1", path], check=True)
        _frames[t] = Image.open(path).convert("RGB"); os.remove(path)
    return _frames[t]

def rounded(img, radius):
    """A rounded-corner mask for img (supersampled for smooth corners)."""
    w, h = img.size
    m = Image.new("L", (w * 3, h * 3), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, w * 3 - 1, h * 3 - 1), radius=radius * 3, fill=255)
    return m.resize((w, h), Image.LANCZOS)

def click_tile(key):
    t, (cx0, cy0, cx1, cy1), buttons = CLICK[key]
    tile = grab(t).crop(COL).crop((cx0, cy0, cx1, cy1))
    d = ImageDraw.Draw(tile)
    for (x0, y0, x1, y1) in buttons:
        d.rounded_rectangle((x0 - cx0 - 5, y0 - cy0 - 5, x1 - cx0 + 5, y1 - cy0 + 5),
                            radius=14, outline=ORANGE, width=6)
    return tile

def click_strip(spec):
    """The click tiles in a row, with 'then' / 'or' between them."""
    wf = font(34, "Medium")
    parts = [("word", s) if s in ("then", "or") else ("tile", click_tile(s)) for s in spec]
    h = max(p[1].height for p in parts if p[0] == "tile")
    return parts, h, wf, 26

def compose(name, body, title, sub, boxes_px, spec):
    cw, ch = body.size
    tf, sf, lf = font(66, "Semibold"), font(38), font(34, "Semibold")
    head = 70 + 82 + 54 + 46
    strip = None
    if spec:
        strip = click_strip(spec)
        s_top = head - 6
        head = s_top + strip[1] + 50
    W, H = cw + 2 * M, head + ch + M
    im = Image.new("RGB", (W, H), BG)
    # soft shadow under the card
    sh = Image.new("L", (W, H), 0)
    ImageDraw.Draw(sh).rounded_rectangle((M + 6, head + 18, M + cw - 6, head + ch + 22), radius=34, fill=80)
    im.paste(Image.new("RGB", (W, H), (120, 110, 95)), (0, 0), sh.filter(ImageFilter.GaussianBlur(26)))
    # card
    card = body.copy(); cd = ImageDraw.Draw(card)
    for (x0, y0, x1, y1) in boxes_px:
        cd.rounded_rectangle((x0 - 10, y0 - 10, x1 + 10, y1 + 10), radius=18, outline=ORANGE, width=8)
    im.paste(card, (M, head), rounded(card, 30))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((M, head, M + cw - 1, head + ch - 1), radius=30, outline=EDGE, width=2)
    d.text((M, 70), title, font=tf, fill=INK)
    d.text((M, 70 + 92), sub, font=sf, fill=MUTED)
    if strip:
        parts, shh, wf, gap = strip
        label = "You click"
        x = M; cy = s_top + shh / 2
        d.text((x, cy), label, font=lf, fill=INK, anchor="lm")
        x += int(lf.getlength(label)) + 34
        for kind, p in parts:
            if kind == "word":
                ImageDraw.Draw(im).text((x, cy), p, font=wf, fill=MUTED, anchor="lm")
                x += int(wf.getlength(p)) + gap
                continue
            y = int(cy - p.height / 2)
            tsh = Image.new("L", (W, H), 0)
            ImageDraw.Draw(tsh).rounded_rectangle((x + 3, y + 8, x + p.width - 3, y + p.height + 10), radius=14, fill=60)
            im.paste(Image.new("RGB", (W, H), (120, 110, 95)), (0, 0), tsh.filter(ImageFilter.GaussianBlur(12)))
            im.paste(p, (x, y), rounded(p, 14))
            ImageDraw.Draw(im).rounded_rectangle((x, y, x + p.width - 1, y + p.height - 1), radius=14, outline=EDGE, width=2)
            x += p.width + gap
        assert x - gap <= W - M, f"{name}: click strip too wide ({x - gap} > {W - M})"
    im.save(os.path.join(OUTDIR, name + ".png"), optimize=True)
    print(name, im.size)

for name, t, top, bottom, title, sub, boxes, spec in STILLS:
    col = grab(t).crop(COL)
    body = col.crop((X0, int(top * K), X1, int(bottom * K)))
    px = [(x0 * K - X0, (y0 - top) * K, x1 * K - X0, (y1 - top) * K) for (x0, y0, x1, y1) in boxes]
    compose(name, body, title, sub, px, spec)

# 13: the whole window, other project names blurred, cropped to the sidebar and the reply.
win = grab(453.0).crop((0, 81, 2880, 2229))
for (x0, y0, x1, y1) in [(15, 603, 645, 885), (15, 1095, 645, 1167), (15, 2073, 645, 2148)]:
    reg = win.crop((x0, y0, x1, y1))
    sm = reg.resize((max(1, reg.width // 24), max(1, reg.height // 24)))
    win.paste(sm.resize(reg.size, Image.BILINEAR).filter(ImageFilter.GaussianBlur(6)), (x0, y0))
body = win.crop((0, 560, 2880, 1840))
s = 1880 / body.width
body = body.resize((1880, round(body.height * s)), Image.LANCZOS)
px = [((x0) * s, (y0 - 560) * s, (x1) * s, (y1 - 560) * s) for (x0, y0, x1, y1) in [(15, 960, 645, 1095), (1320, 1497, 2670, 1761)]]
compose("13-fork-is-its-own-session", body, "The fork is a session of its own",
        "It sits under the original session in the sidebar, and the original hears back from it.", px, ["start"])
