"""Make the poster picture for the demo video: one frame plus a play button.
Pick SECONDS between two narration lines, so no subtitle shows.
Usage: python make_poster.py VIDEO.mp4 SECONDS OUT.jpg"""
import subprocess, sys
from PIL import Image, ImageDraw
vid, t, out = sys.argv[1], sys.argv[2], sys.argv[3]
subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", t, "-i", vid, "-frames:v", "1", "/tmp/_poster.png"], check=True)
im = Image.open("/tmp/_poster.png").convert("RGB")
# play button on the card
ov = Image.new("RGBA", im.size, (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
cx, cy, r = 48 + 720, 48 + 560, 86
d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(28, 27, 25, 200))
d.polygon([(cx - 26, cy - 40), (cx - 26, cy + 40), (cx + 44, cy)], fill=(255, 255, 255, 255))
im = Image.alpha_composite(im.convert("RGBA"), ov).convert("RGB")
im.save(out, quality=88, optimize=True, progressive=True)
print(out, im.size)
