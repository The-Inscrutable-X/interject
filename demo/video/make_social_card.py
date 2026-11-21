"""Make the link preview card (1280 x 640): the picture that X, Slack or
iMessage show when someone shares the blog post, and the GitHub repository's
social preview (Settings > Social preview).

Run (needs ffmpeg and Pillow):  python make_social_card.py RAW.mov OUT.png
"""
import os, subprocess, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

RAW, OUT = sys.argv[1], sys.argv[2]
W, H = 1280, 640
BG, INK, MUTED, ORANGE, EDGE = (243, 241, 236), (28, 27, 25), (118, 113, 104), (217, 119, 87), (222, 218, 210)
SF = "/System/Library/Fonts/SFNS.ttf"
def font(size, weight="Regular"):
    f = ImageFont.truetype(SF, size); f.set_variation_by_name(weight); return f

# The side answer at its line, from the raw recording (same moment as still 03).
tmp = OUT + ".frame.png"
subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-ss", "171.0", "-i", RAW, "-frames:v", "1", tmp], check=True)
col = Image.open(tmp).convert("RGB").crop((1011, 170, 1011 + 2100, 170 + 2064)); os.remove(tmp)
shot = col.crop((300, 822, 1920, 1488))                     # "2.1 Baseline" heading through the Adam paper link
sw = 690; shot = shot.resize((sw, round(shot.height * sw / shot.width)), Image.LANCZOS)
paper = shot.getpixel((sw - 4, shot.height - 4))              # the chat's own background colour
fade = Image.linear_gradient("L").resize((sw, 22))           # black at the top, white at the bottom
shot.paste(Image.new("RGB", (sw, 22), paper), (0, shot.height - 22), fade)

im = Image.new("RGB", (W, H), BG)
x0, y0 = W - sw - 56, (H - shot.height) // 2
sh = Image.new("L", (W, H), 0)
ImageDraw.Draw(sh).rounded_rectangle((x0 + 6, y0 + 14, x0 + sw - 6, y0 + shot.height + 18), radius=22, fill=90)
im.paste(Image.new("RGB", (W, H), (120, 110, 95)), (0, 0), sh.filter(ImageFilter.GaussianBlur(18)))
m = Image.new("L", (sw * 3, shot.height * 3), 0)
ImageDraw.Draw(m).rounded_rectangle((0, 0, sw * 3 - 1, shot.height * 3 - 1), radius=54, fill=255)
im.paste(shot, (x0, y0), m.resize(shot.size, Image.LANCZOS))
d = ImageDraw.Draw(im)
d.rounded_rectangle((x0, y0, x0 + sw - 1, y0 + shot.height - 1), radius=18, outline=EDGE, width=2)

lx = 64
d.text((lx, 150), "Interject", font=font(92, "Bold"), fill=INK)
d.rectangle((lx + 4, 268, lx + 84, 274), fill=ORANGE)
for i, line in enumerate(["Ask about any line of a", "Claude reply, right where", "you read it."]):
    d.text((lx, 300 + i * 46), line, font=font(36), fill=INK)
d.text((lx, 460), "Everything stays inline.", font=font(30, "Semibold"), fill=ORANGE)
d.text((lx, 548), "A Claude Code mod  ·  free and open source", font=font(22), fill=MUTED)
im.save(OUT, optimize=True)
print(OUT, im.size)
