"""Render the narrated Interject demo (16:9, 1080p) from the raw Desktop recording.

Layout: the chat sits in a rounded card on the left, seen through a camera that
pans and zooms to the part that matters. A chapter list sits on the right.
Subtitles of the voiceover run under the card.

Timing: each narration line has an anchor (a moment in the raw recording). If the
video reaches an anchor while the previous line is still being spoken, the video
holds that frame until the voice is free, so words and pictures stay in step.

Usage (Anaconda Python, needs numpy, scipy, opencv, Pillow, ffmpeg, macOS `say`):
  python render.py full OUT.mp4        final quality
  python render.py draft OUT.mp4       quick look: 10 fps, fast encode
  python render.py timing x.mp4        print the timeline only
  python render.py camsheet DIR        camera boxes over the source (needs 1 fps frames in ../frames)
"""
import json, math, os, subprocess, sys, wave
import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.environ.get("RAW", os.path.join(HERE, "..", "raw", "screen-recording-2026-11-20.mov"))
VOICE = os.environ.get("VOICE", "Samantha")
MODE = sys.argv[1]
OUT = sys.argv[2]
FPS = 10 if MODE == "draft" else 30

W, H = 1920, 1080
CX, CY, CW, CHH = 48, 48, 1440, 900          # the app card
AR = CW / CHH
BG = (243, 241, 236)                         # RGB, warm paper
INK, ORANGE, MUTED, FAINT = (28, 27, 25), (217, 119, 87), (128, 123, 114), (190, 185, 176)
APPBG = (254, 254, 254)
COLX = 1051                                  # chat column centre, in column coordinates
SF = "/System/Library/Fonts/SFNS.ttf"

# Sources: "col" is the chat column; "win" is the whole window (other names blurred).
SRC = {
    "col": dict(x=1011, y=170, w=2100, h=2064),
    "win": dict(x=0, y=81, w=2880, h=2148,
                blur=[(15, 603, 645, 885), (15, 1095, 645, 1167), (15, 2073, 645, 2148)]),
}

def C(v):  # 1400-wide video content coords -> column coords
    return tuple(round(1.5 * a) for a in v)

# ---------------------------------------------------------------------------
# The story. Times are seconds in the raw recording.
#   segs: (start, end, speed[, tag])       tag "skip:<text>" or "note:<text>" shows a pill
#   cam:  (time, top, width[, centre x])   camera keyframes; eased in between
#   hl:   (start, end, rect, dim)          orange box; dim darkens everything else
#   lines:(anchor, narration key)
# ---------------------------------------------------------------------------
CHAPTERS = [
    dict(title="A long reply", src="col",
         segs=[(1.0, 3.5, 1), (91.6, 95.6, 1, "skip:1.5 min later")],
         cam=[(0, 0, 1640), (92.2, 0, 1640), (95.6, 860, 1640)],
         hl=[], lines=[(1.1, "c1a"), (91.7, "c1b")]),
    dict(title="Interject at any line", src="col",
         segs=[(134.6, 150.5, 1)],
         cam=[(135, 900, 1640), (145.2, 900, 1640), (146.8, 600, 1640), (148.4, 600, 1640), (149.9, 280, 1640)],
         hl=[(135.4, 136.25, C((350, 676, 414, 704)), False),
             (134.7, 136.25, C((196, 1206, 370, 1246)), False),
             (141.1, 142.1, C((402, 874, 634, 916)), False)],
         lines=[(134.7, "c2a"), (135.95, "c2b"), (141.1, "c2c"), (145.3, "c2d")]),
    dict(title="Ask on the side", src="col",
         segs=[(150.5, 154.2, 1), (160.6, 164.6, 1), (164.6, 172.2, 4)],
         cam=[(150.5, 280, 1640), (152.3, 1000, 1640), (165, 1000, 1640), (171, 700, 1640)],
         hl=[(162.8, 164.3, C((220, 940, 388, 984)), False)],
         lines=[(150.6, "c3a"), (163.0, "c3b"), (170.6, "c3c")]),
    dict(title="Follow up and nest", src="col",
         segs=[(172.2, 180.0, 1), (180.0, 184.0, 4), (184.0, 189.5, 1.25), (193.8, 198.0, 1.5),
               (198.0, 205.0, 1), (210.5, 213.0, 1), (213.0, 216.2, 3)],
         cam=[(172, 700, 1640), (198.0, 700, 1640), (199.6, 430, 1640), (212.8, 430, 1640), (215.8, 200, 1640)],
         hl=[(172.5, 174.2, C((218, 1014, 320, 1052)), False)],
         lines=[(172.3, "c4a"), (185.5, "c4a2"), (199.0, "c4b"), (210.8, "c4c")]),
    dict(title="Keep for next message", src="col",
         segs=[(219.5, 225.0, 1.5), (225.0, 228.8, 1),
               (239.8, 245.2, 0.75, "pause:1.6"), (248.8, 250.4, 0.75)],
         cam=[(219, 880, 1640), (245.2, 880, 1640), (248.8, 455, 2160)],
         hl=[(239.9, 240.9, (975, 1460, 1335, 1520), False),     # Add to my next message
             (241.0, 243.4, (330, 1290, 870, 1322), False),      # Will be attached to your next message.
             (241.0, 243.4, (300, 1820, 905, 1860), False),      # 1 box goes with your next message
             (243.6, 244.55, (515, 1075, 600, 1110), False),     # keep
             (244.6, 245.6, (330, 1075, 830, 1110), False),      # Kept: goes with your next message.
             (244.6, 245.6, (300, 1820, 905, 1860), False),      # 3 boxes go with your next message
             (248.85, 251.0, (330, 478, 1000, 552), False),      # the box it builds on
             (248.85, 251.0, (330, 1714, 1180, 1750), False)],   # Kept with a question built on it
         lines=[(225.2, "c5a"), (241.1, "c5a2"), (243.5, "c5b"), (248.85, "c5c")]),
    dict(title="Cut and continue", src="col",
         segs=[(252.0, 262.5, 1.25), (262.5, 285.0, 6), (285.0, 296.0, 1), (349.5, 357.5, 1)],
         cam=[(252, 420, 1640), (349.0, 420, 1640), (349.5, 0, 1640)],
         hl=[(288.6, 289.6, C((910, 710, 1122, 750)), False)],
         lines=[(256.5, "c6a"), (266.0, "c6b"), (288.9, "c6c"), (291.0, "c6d"), (349.8, "c6e")]),
    dict(title="See what's sent", src="col",
         segs=[(316.0, 322.0, 1), (322.0, 334.0, 3), (334.0, 338.0, 1), (361.5, 369.0, 1)],
         cam=[(316, 1000, 1640), (318.6, 1000, 1640), (321.0, 200, 1640), (331.5, 200, 1640),
              (334.2, 1000, 1640), (338.5, 1000, 1640), (361.0, 100, 1640)],
         hl=[(316.8, 319.0, C((200, 1206, 604, 1248)), False),
             (364.5, 365.8, C((204, 272, 576, 298)), False)],
         lines=[(317.0, "c7a"), (362.0, "c7b"), (365.2, "c7c")]),
    dict(title="Fork to session", src="col",
         segs=[(389.5, 393.5, 1), (409.0, 416.0, 1), (416.0, 426.5, 4),
               (431.5, 434.0, 2, "note:Bypass permissions mode on"), (434.0, 445.0, 1)],
         cam=[(389, 700, 1640)],
         hl=[(435.3, 436.2, C((424, 872, 566, 906)), False),
             (440.0, 441.6, C((762, 988, 838, 1032)), False)],
         lines=[(390.0, "c8a"), (435.0, "c8b")]),
    dict(title="Fork to session", src="win", same_chapter=True,
         segs=[(445.0, 453.3, 1)],
         cam=[(445, 560, 2000, 1000), (452.4, 560, 2000, 1000), (453.1, 900, 2000, 1880)],
         hl=[(446.5, 470, (15, 960, 645, 1095), False), (452.6, 470, (1320, 1497, 2670, 1761), False)],
         lines=[(445.3, "c8c"), (452.7, "c8d")], hold_end=2.0),
]
TEASER = [
    # One continuous example on one line: select "2.1 Baseline", click Interject here, the form
    # opens, the question goes in, Ask on the side, and the answer arrives in the same box.
    # Claude Code's own "Start a side chat / Reply" popup above the selection is covered with the
    # clean page from just before the selection (patch). The camera eases up as the form opens.
    dict(title="Interject at any line", src="col",
         segs=[(150.6, 155.0, 0.8)],
         cam=[(150.6, 990, 1500), (153.4, 990, 1500), (154.9, 765, 1500)],
         patch=[(151.1, 154.5, (360, 1046, 806, 1127), 150.5)],
         hl=[(151.5, 152.5, (306, 1128, 862, 1172), False),         # the selected line
             (152.35, 153.05, (298, 1812, 552, 1866), False)],      # Interject here
         lines=[(150.7, "t1")]),
    # The waits are cut where nothing on screen changes (155.0-161.6 and 165.4-168.0), so the cuts
    # don't show. The page scrolls 262 px as the answer lands, and the camera moves with it, so the
    # answer holds still and the frame stops above its last paragraph. The voice, not the screen,
    # says that the agent has full tool use.
    dict(title="Ask on the side", src="col",
         segs=[(161.6, 165.4, 1), (168.0, 172.3, 1, "pause:1.6")],
         cam=[(161.6, 765, 1500), (170.0, 765, 1500), (171.5, 503, 1500), (172.3, 503, 1500)],
         hl=[(163.3, 164.15, (330, 1410, 590, 1476), False),        # Ask on the side (clicked at 164.15)
             (171.55, 174.0, (305, 866, 862, 902), False)],         # the line the answer belongs to
         lines=[(161.7, "t3")]),
    dict(title="Keep for next message", src="col",
         segs=[(243.2, 245.2, 0.75, "pause:1.2")],
         cam=[(243, 270, 1500)],
         hl=[(243.6, 244.55, (510, 1080, 600, 1112), False),        # keep
             (244.6, 246.0, (330, 1080, 830, 1112), False)],        # Kept: goes with your next message.
         lines=[(243.3, "t4")]),
    # Cut here and continue: the form turns into the cut box in place (the page reflows 348 px at
    # the click, so the camera follows it), then the rewrite that defines every symbol.
    dict(title="Cut and continue", src="col",
         # The video stops on the finished note while the request is marked and read out (t5b),
         # then the click, the cut, and the rewrite with its new list of symbols (t5c).
         segs=[(288.4, 289.6, 1, "pause:2.0"), (289.6, 290.15, 1), (290.4, 291.3, 1, "pause:0.6"),
               (351.8, 352.5, 1, "pause:1.8")],
         cam=[(288.4, 745, 1500), (290.15, 745, 1500), (290.4, 1093, 1500), (291.3, 1093, 1500),
              (351.8, 0, 1500), (352.5, 0, 1500)],
         hl=[(289.5, 289.75, (995, 938, 1539, 968), False, "mark"), # "Before every equation, please define what
             (289.5, 289.75, (357, 977, 820, 1006), False, "mark"),  #  exactly each of the symbols means."
             (289.8, 290.15, C((910, 710, 1122, 750)), False),      # Cut here and continue
             (290.45, 292.0, (305, 1446, 915, 1488), False),        # The rest of this reply (112 lines) was cut.
             (351.9, 354.0, (300, 190, 1530, 475), False)],         # Symbols for the baseline update
         lines=[(288.5, "t5"), (289.55, "t5b"), (351.85, "t5c")]),
    # Fork to session: click it, the New session card appears (437.4), and the video pauses on the
    # card with its Start button boxed. Ending here skips a stray text selection after 438.6.
    dict(title="Fork to session", src="col",
         segs=[(434.6, 438.4, 1, "pause:1.4")],
         cam=[(434, 760, 1500)],
         hl=[(435.65, 436.42, C((424, 872, 566, 906)), False),       # fork to session
             (437.7, 440.0, (1143, 1578, 1257, 1644), False)],      # Start
         lines=[(434.8, "t6")]),
    # The fork in the sidebar, zoomed in so it reads on a phone, then the message it sends back.
    dict(title="Fork to session", src="win", same_chapter=True,
         segs=[(449.0, 453.3, 1)],
         cam=[(449, 640, 1300, 650), (452.4, 640, 1300, 650), (453.1, 1150, 1600, 1995)],
         hl=[(449.0, 470, (15, 960, 645, 1095), False), (452.6, 470, (1320, 1497, 2670, 1761), False)],
         lines=[(449.2, "t7")], hold_end=2.2),
]
TEASER_TOC = ["Interject at any line", "Ask on the side", "Keep for next message",
              "Cut and continue", "Fork to session"]
TOC = ["A long reply", "Interject at any line", "Ask on the side", "Follow up and nest",
       "Keep for next message", "Cut and continue", "See what's sent", "Fork to session"]
INTRO_SEC, OUTRO_SEC = 6.4, 6.0
STORY = os.environ.get("STORY", "full")      # "teaser": the short cut for social posts
OUTRO_KEY = "outro"
if STORY == "teaser":
    CHAPTERS, TOC = TEASER, TEASER_TOC
    INTRO_SEC, OUTRO_SEC, OUTRO_KEY = 0.0, 4.6, "t_outro"
GAP, TAIL, XF = 0.35, 0.7, 0.3          # pause between lines, after a chapter, crossfade
if os.environ.get("STORY") == "teaser":
    GAP, TAIL = 0.55, 1.3                # the teaser is short, so let each line breathe

def font(size, weight="Regular"):
    f = ImageFont.truetype(SF, size); f.set_variation_by_name(weight); return f

# ---------------------------------------------------------------------------
# Voice clips
# ---------------------------------------------------------------------------
NARR = json.load(open(os.path.join(HERE, "narration.json")))
VO = {}
def load_vo(key):
    path = os.path.join(HERE, "vo", f"{VOICE}_{key}.wav")
    w = wave.open(path); a = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
    sr = w.getframerate(); assert sr == 48000
    env = np.abs(a); thr = 10 ** (-45 / 20)
    idx = np.where(env > thr)[0]
    a = a[max(0, idx[0] - 960): min(len(a), idx[-1] + 2400)]
    rms = np.sqrt(np.mean(a[np.abs(a) > 0.01] ** 2))
    a = a * (10 ** (-19 / 20) / rms)
    return a
for k in NARR:
    VO[k] = load_vo(k)
def vdur(k): return len(VO[k]) / 48000

# ---------------------------------------------------------------------------
# Timeline: segments, holds and narration placement
# ---------------------------------------------------------------------------
def build():
    t = 0.0
    plan = []          # items: dict(kind, ...)
    speech = []        # (start, key)
    if INTRO_SEC > 0:
        plan.append(dict(kind="card", which="intro", t0=t, dur=INTRO_SEC)); speech.append((0.7, "intro"))
        free = 0.7 + vdur("intro") + GAP
        t += INTRO_SEC
    else:
        free = 0.15
    ch_index = -1
    prev_end = None
    for ci, ch in enumerate(CHAPTERS):
        if not ch.get("same_chapter"): ch_index += 1
        lines = sorted(ch["lines"])
        for si, sg in enumerate(ch["segs"]):
            s, e, sp = sg[:3]; tag = sg[3] if len(sg) > 3 else None
            cut = prev_end is not None and (abs(s - prev_end) > 0.05 or ch["src"] != prev_src)
            pieces = []
            pos = s
            for (a, key) in [l for l in lines if s <= l[0] < e]:
                if a > pos: pieces.append(("play", pos, a)); t += (a - pos) / sp; pos = a
                if t < free:
                    pieces.append(("hold", pos, free - t)); t = free
                speech.append((t, key)); free = t + vdur(key) + GAP
            if e > pos: pieces.append(("play", pos, e)); t += (e - pos) / sp
            if tag and tag.startswith("pause:"):
                hold = float(tag.split(":", 1)[1]); pieces.append(("hold", e, hold)); t += hold
            plan.append(dict(kind="seg", ch=ci, toc=ch_index, s=s, e=e, sp=sp, tag=tag, cut=cut,
                             pieces=pieces, src=ch["src"]))
            prev_end = e; prev_src = ch["src"]
        last = plan[-1]
        need = free - GAP + TAIL - t
        hold = max(need, ch.get("hold_end", 0))
        if hold > 0:
            last["pieces"].append(("hold", last["e"], hold)); t += hold
    plan.append(dict(kind="card", which="outro", t0=t, dur=OUTRO_SEC))
    if t < free: t = free
    speech.append((t + 0.8, OUTRO_KEY))
    total = t + OUTRO_SEC
    return plan, speech, total

# ---------------------------------------------------------------------------
# Static art: background, card shadow, chapter panel, cards, subtitles, pills
# ---------------------------------------------------------------------------
def to_bgr(im): return cv2.cvtColor(np.array(im.convert("RGB")), cv2.COLOR_RGB2BGR)

def base_image(active):
    im = Image.new("RGB", (W, H), BG)
    sh = Image.new("L", (W, H), 0); d = ImageDraw.Draw(sh)
    d.rounded_rectangle((CX + 4, CY + 14, CX + CW - 4, CY + CHH + 18), radius=24, fill=70)
    sh = sh.filter(ImageFilter.GaussianBlur(22))
    im.paste(Image.new("RGB", (W, H), (120, 110, 95)), (0, 0), sh)
    d = ImageDraw.Draw(im)
    px = 1530
    d.text((px, 54), "Interject", font=font(56, "Bold"), fill=INK)
    d.rectangle((px + 2, 130, px + 62, 136), fill=ORANGE)
    d.text((px, 152), "A Claude Code mod", font=font(26), fill=MUTED)
    y = 250
    for i, name in enumerate(TOC):
        if i == active:
            d.rounded_rectangle((px - 18, y - 12, 1890, y + 50), radius=14, fill=(255, 255, 255))
            d.rectangle((px - 18, y - 12, px - 12, y + 50), fill=ORANGE)
            d.text((px, y), f"{i + 1}", font=font(30, "Semibold"), fill=ORANGE)
            d.text((px + 34, y), name, font=font(30, "Semibold"), fill=INK)
        else:
            col = MUTED if (active is not None and i < active) else FAINT
            d.text((px, y + 2), f"{i + 1}", font=font(28), fill=col)
            d.text((px + 34, y + 2), name, font=font(28), fill=col)
        y += 72
    d.text((px, 1000), "Shown in Claude Code Desktop", font=font(22), fill=FAINT)
    return to_bgr(im)

def edge_fade():
    fy = np.ones(CHH, np.float32); fx = np.ones(CW, np.float32)
    n = 26
    ramp = smooth(np.linspace(0, 1, n))
    fy[:n] = ramp; fy[-n:] = ramp[::-1]
    fx[:n] = ramp; fx[-n:] = ramp[::-1]
    return (fy[:, None] * fx[None, :])[:, :, None]

def card_mask():
    m = Image.new("L", (CW * 4, CHH * 4), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, CW * 4 - 1, CHH * 4 - 1), radius=22 * 4, fill=255)
    m = np.array(m.resize((CW, CHH), Image.LANCZOS)).astype(np.float32) / 255
    b = Image.new("L", (CW * 4, CHH * 4), 0)
    ImageDraw.Draw(b).rounded_rectangle((0, 0, CW * 4 - 1, CHH * 4 - 1), radius=22 * 4, outline=255, width=6)
    b = np.array(b.resize((CW, CHH), Image.LANCZOS)).astype(np.float32) / 255 * 0.55
    E = np.where((m < 0.999) | (b > 0.001))
    return E, m[E][:, None], b[E][:, None]

def title_card(which):
    im = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(im)
    def ctext(y, s, f, fill):
        d.text(((W - d.textlength(s, font=f)) / 2, y), s, font=f, fill=fill)
    if which == "intro":
        ctext(330, "Interject", font(150, "Bold"), INK)
        d.rectangle((W / 2 - 60, 525, W / 2 + 60, 533), fill=ORANGE)
        ctext(575, "Ask about any line of Claude's reply,", font(50), INK)
        ctext(640, "right where you read it.", font(50), INK)
        ctext(860, "A Claude Code mod  ·  shown in Claude Code Desktop", font(28), MUTED)
    elif STORY == "teaser":
        ctext(270, "Interject", font(150, "Bold"), INK)
        d.rectangle((W / 2 - 60, 465, W / 2 + 60, 473), fill=ORANGE)
        ctext(515, "Ask about any line of Claude's reply, right where you read it.", font(46), INK)
        ctext(650, "Ask Claude to install Interject", font(42, "Semibold"), INK)
        f = font(40, "Semibold"); url = "github.com/The-Inscrutable-X/interject"
        wd = d.textlength(url, font=f) + 80; x = (W - wd) / 2
        d.rounded_rectangle((x, 728, x + wd, 814), radius=43, fill=(255, 255, 255), outline=(226, 222, 214), width=2)
        d.text((x + 40, 748), url, font=f, fill=INK)
        ctext(900, "A Claude Code mod  ·  free and open source", font(30), MUTED)
    else:
        ctext(190, "Interject", font(120, "Bold"), INK)
        d.rectangle((W / 2 - 60, 355, W / 2 + 60, 363), fill=ORANGE)
        ctext(395, "Ask about any line, right where you read it.", font(44), INK)
        f = font(32, "Medium"); y = 540
        rows = [TOC[1:4], TOC[4:8]]
        for row in rows:
            widths = [d.textlength(s, font=f) + 64 for s in row]
            x = (W - (sum(widths) + 24 * (len(row) - 1))) / 2
            for s, wd in zip(row, widths):
                d.rounded_rectangle((x, y, x + wd, y + 70), radius=35, fill=(255, 255, 255), outline=(226, 222, 214), width=2)
                d.text((x + 32, y + 15), s, font=f, fill=INK); x += wd + 24
            y += 100
        ctext(860, "A Claude Code mod", font(28), MUTED)
    return to_bgr(im)

def text_strip(text, width=CW, size=36):
    f = font(size); im = Image.new("L", (width, 110), 0); d = ImageDraw.Draw(im)
    words = text.split(); lines = []; cur = ""
    for w_ in words:
        nxt = (cur + " " + w_).strip()
        if d.textlength(nxt, font=f) > width - 120 and cur: lines.append(cur); cur = w_
        else: cur = nxt
    lines.append(cur)
    y = 8 if len(lines) == 1 else 0
    if len(lines) == 1: y = 30
    for ln in lines:
        d.text(((width - d.textlength(ln, font=f)) / 2, y), ln, font=f, fill=255); y += 48
    return np.array(im).astype(np.float32)[:, :, None] / 255

def pill(text):
    f = font(26, "Semibold"); tw = int(f.getlength(text))
    im = Image.new("RGBA", (tw + 40, 48), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, tw + 39, 47), radius=24, fill=(28, 27, 25, 215))
    d.text((20, 8), text, font=f, fill=(255, 255, 255, 255))
    a = np.array(im).astype(np.float32)
    return cv2.cvtColor(a[:, :, :3].astype(np.uint8), cv2.COLOR_RGB2BGR).astype(np.float32), a[:, :, 3:] / 255

def blend(dst, src, alpha, x, y):
    h, w = alpha.shape[:2]
    reg = dst[y:y + h, x:x + w].astype(np.float32)
    dst[y:y + h, x:x + w] = (src * alpha + reg * (1 - alpha)).astype(np.uint8)

def rounded_rect_pts(x0, y0, x1, y1, r):
    pts = []
    for cx_, cy_, a0 in ((x1 - r, y0 + r, -90), (x1 - r, y1 - r, 0), (x0 + r, y1 - r, 90), (x0 + r, y0 + r, 180)):
        for k in range(0, 91, 10):
            a = math.radians(a0 + k); pts.append((cx_ + r * math.cos(a), cy_ + r * math.sin(a)))
    return np.array(pts, np.float32)

# ---------------------------------------------------------------------------
# Camera and frames
# ---------------------------------------------------------------------------
def smooth(a): return a * a * (3 - 2 * a)

def cam_at(cams, src, t):
    def rect(k):
        tt, top, w = k[:3]; cx = k[3] if len(k) > 3 else (COLX if src == "col" else SRC[src]["w"] / 2)
        return cx, top, w
    if t <= cams[0][0] or len(cams) == 1: cx, top, w = rect(cams[0])
    elif t >= cams[-1][0]: cx, top, w = rect(cams[-1])
    else:
        i = max(j for j in range(len(cams)) if cams[j][0] <= t)
        a = smooth((t - cams[i][0]) / (cams[i + 1][0] - cams[i][0]))
        r0, r1 = rect(cams[i]), rect(cams[i + 1])
        cx, top, w = [u + (v - u) * a for u, v in zip(r0, r1)]
    h = w / AR
    return cx - w / 2, top, w, h

def view(src_img, r):
    x0, y0, w, h = r; s = CW / w
    img = src_img; f = 1.0
    if s < 0.7:
        f = min(1.0, s * 1.4)
        img = cv2.resize(src_img, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
    s2 = s / f
    M = np.float32([[s2, 0, -x0 * s], [0, s2, -y0 * s]])
    return cv2.warpAffine(img, M, (CW, CHH), flags=cv2.INTER_CUBIC,
                          borderMode=cv2.BORDER_CONSTANT, borderValue=APPBG[::-1])

_refs = {}
def ref_frame(t, src):
    """One frame of the source at time t, cropped like reader() crops it (for patches)."""
    if (t, src) not in _refs:
        g = SRC[src]
        p = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{t:.3f}", "-i", RAW, "-frames:v", "1",
                            "-vf", f"crop={g['w']}:{g['h']}:{g['x']}:{g['y']}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                           capture_output=True, check=True).stdout
        _refs[(t, src)] = np.frombuffer(p, np.uint8).reshape(g["h"], g["w"], 3)
    return _refs[(t, src)]

def reader(s, e, sp, src):
    g = SRC[src]
    vf = f"setpts=(PTS-STARTPTS)/{sp},fps={FPS},crop={g['w']}:{g['h']}:{g['x']}:{g['y']}"
    cmd = ["ffmpeg", "-v", "error", "-ss", f"{s:.3f}", "-t", f"{e - s + 0.5:.3f}", "-i", RAW,
           "-vf", vf, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    p = subprocess.Popen(["ffmpeg", "-nostdin"] + cmd[1:], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=1 << 26)
    size = g["w"] * g["h"] * 3; last = None
    try:
     while True:
         buf = p.stdout.read(size)
         if len(buf) < size: break
         fr = np.frombuffer(buf, np.uint8).reshape(g["h"], g["w"], 3)
         if "blur" in g:
             fr = fr.copy()
             for (x0, y0, x1, y1) in g["blur"]:
                 reg = fr[y0:y1, x0:x1]
                 sm = cv2.resize(reg, (max(1, (x1 - x0) // 24), max(1, (y1 - y0) // 24)), interpolation=cv2.INTER_AREA)
                 fr[y0:y1, x0:x1] = cv2.GaussianBlur(cv2.resize(sm, (x1 - x0, y1 - y0), interpolation=cv2.INTER_LINEAR), (0, 0), 6)
         last = fr; yield fr
     while True: yield last
    finally:
        p.kill(); p.wait()

def render(plan, speech, total, out_video):
    bases = {i: base_image(i) for i in range(len(TOC))}
    bases[None] = base_image(None)
    intro, outro = title_card("intro"), title_card("outro")
    E, mE, bE = card_mask()
    global FADE, WHITE
    FADE = edge_fade(); WHITE = np.array(APPBG[::-1], np.float32)
    pills = {}
    subs = [(st, st + vdur(k) + 0.25, text_strip(NARR[k])) for st, k in speech if k not in ("intro", "outro", "t_outro")]
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
                            "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                            "-c:v", "libx264", "-preset", "veryfast" if MODE == "draft" else "slow",
                            "-crf", "23" if MODE == "draft" else "18", "-pix_fmt", "yuv420p", out_video],
                           stdin=subprocess.PIPE)
    nframes = 0; prev = None; cur_toc = None; toc_change = 0.0

    def emit(fr):
        nonlocal nframes, prev
        tnow = nframes / FPS
        for (a, b, strip) in subs:
            if a - 0.15 <= tnow <= b:
                al = min(1, (tnow - a + 0.15) / 0.15, (b - tnow) / 0.15)
                blend(fr, np.full((110, CW, 3), INK[::-1], np.float32), strip * al, CX, CY + CHH + 12)
        enc.stdin.write(fr.tobytes()); nframes += 1; prev = fr

    for item in plan:
        t0 = nframes / FPS
        if item["kind"] == "card":
            img = intro if item["which"] == "intro" else outro
            n = round((t0 + item["dur"]) * FPS) - nframes
            start = prev
            for i in range(n):
                tt = i / FPS
                if item["which"] == "intro":
                    fr = img.copy()
                else:
                    bgimg = np.empty_like(img); bgimg[:] = BG[::-1]
                    if tt < 0.4:
                        a = smooth(tt / 0.4); fr = (bgimg * a + start * (1 - a)).astype(np.uint8)
                    elif tt < 0.8:
                        a = smooth((tt - 0.4) / 0.4); fr = (img * a + bgimg * (1 - a)).astype(np.uint8)
                    else:
                        fr = img.copy()
                emit(fr)
            continue
        ch = CHAPTERS[item["ch"]]; src = item["src"]
        if item["toc"] != cur_toc: prev_toc, cur_toc, toc_change = cur_toc, item["toc"], t0
        rd = reader(item["s"], item["e"], item["sp"], src)
        k = -1; frame = None; first = True
        tag = item["tag"] if item["tag"] and item["tag"].split(":")[0] in ("skip", "note") else None
        if tag and tag not in pills: pills[tag] = pill(tag.split(":", 1)[1])
        seg_start_frames = nframes
        xf_src = prev.astype(np.float32) if prev is not None else None
        for kind, a, b in item["pieces"]:
            if kind == "play":
                dur = (b - a) / item["sp"]
            else:
                dur = b
            nstart = nframes
            n = round((nframes / FPS + dur) * FPS + 1e-6) - nframes
            for i in range(n):
                if kind == "play":
                    raw = a + (i / FPS) * item["sp"]
                    want = round((raw - item["s"]) * FPS / item["sp"])
                else:
                    raw = a; want = max(k, 0) if frame is not None else 0
                while k < want or frame is None:
                    frame = next(rd); k += 1
                r = cam_at(ch["cam"], src, raw)
                for (p0, p1, (x0, y0, x1, y1), rt) in ch.get("patch", []):
                    if p0 <= raw <= p1:      # hide something on screen with the clean page from time rt
                        frame = frame.copy(); frame[y0:y1, x0:x1] = ref_frame(rt, src)[y0:y1, x0:x1]
                content = view(frame, r)
                s = CW / r[2]
                for h in ch["hl"]:
                    hs, he, rect = h[:3]; style = h[4] if len(h) > 4 else "box"
                    if hs <= raw <= he:
                        al = min(1.0, (raw - hs) / (0.18 * item["sp"]) + 0.15, (he - raw) / (0.18 * item["sp"]) + 0.15)
                        if kind != "play": al = 1.0      # a paused frame shows its boxes in full
                        ov = content.copy()
                        if style == "mark":              # a highlighter stroke behind a phrase
                            x0 = (rect[0] - r[0]) * s - 3; y0 = (rect[1] - r[1]) * s - 2
                            x1 = (rect[2] - r[0]) * s + 3; y1 = (rect[3] - r[1]) * s + 2
                            cv2.rectangle(ov, (int(x0), int(y0)), (int(x1), int(y1)), (120, 200, 255), -1)
                            ov = np.minimum(ov, content)  # multiply-like: dark text stays dark
                            al *= 0.85
                        else:
                            x0 = (rect[0] - r[0]) * s - 7; y0 = (rect[1] - r[1]) * s - 7
                            x1 = (rect[2] - r[0]) * s + 7; y1 = (rect[3] - r[1]) * s + 7
                            cv2.polylines(ov, [rounded_rect_pts(x0, y0, x1, y1, 12).astype(np.int32)], True,
                                          ORANGE[::-1], 4, cv2.LINE_AA)
                        content = cv2.addWeighted(ov, al, content, 1 - al, 0)
                if tag:
                    pb, pa = pills[tag]
                    tl = (nframes - seg_start_frames) / FPS
                    al = 1.0 if tag.startswith("note") else min(1.0, max(0.0, (2.2 - tl) / 0.3))
                    if tl > (3.0 if tag.startswith("note") else 2.2): al = 0
                    if al > 0: blend(content, pb, pa * al, CW - pb.shape[1] - 20, 20)
                speed_chip = None
                if item["sp"] >= 2 and kind == "play":
                    key = f"spd{item['sp']:g}"
                    if key not in pills: pills[key] = pill(f"{item['sp']:g}× speed")
                    speed_chip = pills[key]
                content = (content.astype(np.float32) * FADE + WHITE * (1 - FADE)).astype(np.uint8)
                tnow = nframes / FPS
                base = bases[cur_toc]
                if tnow - toc_change < 0.4 and prev_toc is not None:
                    al = (tnow - toc_change) / 0.4
                    base = (base * al + bases[prev_toc] * (1 - al)).astype(np.uint8)
                fr = base.copy()
                cf = content.astype(np.float32)
                vals = cf[E] * mE + fr[CY:CY + CHH, CX:CX + CW][E].astype(np.float32) * (1 - mE)
                vals = vals * (1 - bE) + np.array([214, 218, 222], np.float32) * bE
                cf[E] = vals
                fr[CY:CY + CHH, CX:CX + CW] = cf.astype(np.uint8)
                if speed_chip is not None:
                    pb, pa = speed_chip; blend(fr, pb, pa, 1530, 846)
                xf_i = nframes - seg_start_frames
                if item["cut"] and xf_src is not None and xf_i < XF * FPS:
                    al = smooth((xf_i + 1) / (XF * FPS + 1))
                    fr = (fr.astype(np.float32) * al + xf_src * (1 - al)).astype(np.uint8)
                emit(fr)
                first = False
    enc.stdin.close(); enc.wait()
    return nframes / FPS

# ---------------------------------------------------------------------------
# Audio: voice at its times, music bed ducked under the voice
# ---------------------------------------------------------------------------
def mix(speech, total, out_wav):
    n = int(total * 48000) + 48000
    voice = np.zeros(n, np.float32)
    for st, k in speech:
        a = VO[k]; i = int(st * 48000); voice[i:i + len(a)] += a[: max(0, n - i)]
    mpath = os.path.join(HERE, "music_bed.wav")
    subprocess.run([sys.executable, os.path.join(HERE, "music.py"), f"{total + 1:.2f}", mpath], check=True)
    w = wave.open(mpath); m = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32).reshape(-1, 2) / 32768
    m = np.pad(m, ((0, max(0, n - len(m))), (0, 0)))[:n]
    env = np.abs(voice)
    k = 2400; env = np.convolve(env, np.ones(k) / k, mode="same")
    act = np.clip(env / 0.02, 0, 1)
    duck = np.empty_like(act); g = 0.0
    up, down = 1 - math.exp(-1 / (0.08 * 48000)), 1 - math.exp(-1 / (0.6 * 48000))
    for i in range(0, n, 480):  # 10 ms steps
        target = act[i]
        g += (target - g) * (1 - (1 - (up if target > g else down)) ** 480)
        duck[i:i + 480] = g
    music_gain = 10 ** (-17 / 20) * (1 - 0.65 * duck)
    mixL = voice + m[:, 0] * music_gain; mixR = voice + m[:, 1] * music_gain
    data = np.stack([mixL, mixR], 1)
    data = np.clip(data, -1, 1)
    ww = wave.open(out_wav, "wb"); ww.setnchannels(2); ww.setsampwidth(2); ww.setframerate(48000)
    ww.writeframes((data * 32767).astype(np.int16).tobytes()); ww.close()

def camsheet(outdir):
    os.makedirs(outdir, exist_ok=True)
    for ci, ch in enumerate(CHAPTERS):
        tiles = []
        times = []
        for sg in ch["segs"]:
            s, e = sg[:2]; tt = math.ceil(s)
            while tt < e: times.append(tt); tt += 1
        g = SRC[ch["src"]]
        for tt in times:
            fr = cv2.imread(os.path.join(os.path.dirname(HERE), "frames", f"f{int(tt) + 1:04d}.jpg"))
            fr = cv2.resize(fr, (3456 // 4, 2234 // 4), interpolation=cv2.INTER_AREA)
            x, y = g["x"] // 4, g["y"] // 4
            tile = fr[y:y + g["h"] // 4, x:x + g["w"] // 4].copy()
            r = cam_at(ch["cam"], ch["src"], tt)
            cv2.rectangle(tile, (int(r[0] / 4), int(r[1] / 4)), (int((r[0] + r[2]) / 4), int((r[1] + r[3]) / 4)), (255, 80, 0), 3)
            for h in ch["hl"]:
                hs, he, rect = h[:3]
                if hs - 1 <= tt <= he + 1:
                    cv2.rectangle(tile, (rect[0] // 4, rect[1] // 4), (rect[2] // 4, rect[3] // 4), (60, 110, 230), 2)
            cv2.putText(tile, f"{tt}", (8, 34), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (0, 0, 220), 3)
            tiles.append(tile)
        th, tw = tiles[0].shape[:2]; cols = 6
        rows = (len(tiles) + cols - 1) // cols
        sheet = np.full((rows * (th + 6), cols * (tw + 6), 3), 120, np.uint8)
        for i, tl in enumerate(tiles):
            r_, c_ = divmod(i, cols); sheet[r_ * (th + 6):r_ * (th + 6) + th, c_ * (tw + 6):c_ * (tw + 6) + tw] = tl
        cv2.imwrite(os.path.join(outdir, f"cam{ci}.jpg"), sheet, [cv2.IMWRITE_JPEG_QUALITY, 80])
        print(ci, ch["title"], len(tiles), sheet.shape)

if __name__ == "__main__":
    plan, speech, total = build()
    if MODE == "camsheet":
        camsheet(OUT); sys.exit()
    if MODE == "timing":
        for it in plan:
            if it["kind"] == "seg":
                print(f"ch{it['ch']} {it['s']:.1f}-{it['e']:.1f} x{it['sp']:g} " + " ".join(
                    f"{p[0]}({p[1]:.1f},{p[2]:.2f})" for p in it["pieces"]))
        for st, k in speech: print(f"{st:7.2f} {vdur(k):4.1f}  {k}: {NARR[k]}")
        print("total", round(total, 1)); sys.exit()
    vid = OUT.replace(".mp4", "_v.mp4"); wav = OUT.replace(".mp4", ".wav")
    dur = render(plan, speech, total, vid)
    mix(speech, dur, wav)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", vid, "-i", wav, "-map", "0:v", "-map", "1:a",
                    "-c:v", "copy", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "192k",
                    "-ar", "48000", "-shortest", "-movflags", "+faststart", OUT], check=True)
    print("done", OUT, round(dur, 1), "s")
