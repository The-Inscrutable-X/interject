"""Recount the posts in demo/thread/thread.md the way X counts them, write the
counts back into its headings, and rebuild demo/thread/preview.html from it.

X's rule: a link counts as 23 characters, an emoji as 2, and most symbols
outside basic Latin (such as the bullet "•" and the pencil "✎") also count as 2.

Run:  python make_thread_preview.py      (from demo/video/)
"""
import html, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
MD = os.path.join(HERE, "..", "thread", "thread.md")
OUT = os.path.join(HERE, "..", "thread", "preview.html")
LIMIT = 280
URL = re.compile(r"\b[\w.-]+\.(?:com|io|org|ai|dev)(?:/[^\s]*)?")
ONE = [(0, 4351), (8192, 8205), (8208, 8223), (8242, 8247)]   # code points that count as 1

def x_length(text):
    n = 23 * len(URL.findall(text))
    for ch in URL.sub("", text):
        cp = ord(ch)
        if cp in (0xFE0F, 0x200D):          # parts of an emoji, already counted
            continue
        n += 1 if any(a <= cp <= b for a, b in ONE) else 2
    return n

HEAD = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="robots" content="noindex,nofollow">\n<meta name="viewport" content="width=device-width, initial-scale=1"><title>Interject thread draft</title>\n<style>\nbody{margin:0;background:#f3f1ec;font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1c1b19}\nmain{max-width:600px;margin:0 auto;padding:24px 16px 80px}\nh1{font-size:22px;margin:8px 0 4px} p.note{color:#6b665e;font-size:14px;margin:0 0 20px}\n.post{display:flex;gap:12px;background:#fff;border:1px solid #e2ded6;border-radius:14px;padding:14px;margin:0 0 10px;position:relative}\n.post:not(:last-child)::after{content:"";position:absolute;left:33px;bottom:-11px;width:2px;height:12px;background:#d8d3ca}\n.av{flex:none;width:40px;height:40px;border-radius:50%;background:#d97757;color:#fff;display:grid;place-items:center;font-weight:700}\n.body{min-width:0;flex:1} .who span{color:#6b665e}\n.txt{white-space:pre-wrap;margin:4px 0 10px;overflow-wrap:anywhere} .link{color:#1d6fb8}\nimg,video{width:100%;border-radius:12px;border:1px solid #e2ded6;display:block}\n.count{color:#9a958c;font-size:12px;text-align:right;margin-top:6px}\n</style></head><body><main><h1>Interject launch thread: draft</h1>\n<p class="note">Not linked from the site. Copy-ready text and the posting checklist are in thread.md.</p>\n'

md = open(MD, encoding="utf-8").read()
post_re = re.compile(r"### (\d+)/(\d+)  \((\d+) of 280 characters(?:, attach ([^)]+))?\)\n\n```\n(.*?)\n```", re.S)
posts, over = [], []
def recount(m):
    i, total, _, attach, text = m.groups()
    n = x_length(text)
    if n > LIMIT: over.append((i, n))
    posts.append((i, total, attach, text, n))
    a = f", attach {attach}" if attach else ""
    return f"### {i}/{total}  ({n} of 280 characters{a})\n\n```\n{text}\n```"
md = post_re.sub(recount, md)
open(MD, "w", encoding="utf-8").write(md)

def body(text):
    out, last = [], 0
    for m in URL.finditer(text):
        out.append(html.escape(text[last:m.start()])); out.append(f'<span class="link">{html.escape(m.group())}</span>'); last = m.end()
    out.append(html.escape(text[last:]))
    return "".join(out)

page = HEAD
for i, total, attach, text, n in posts:
    media = ""
    if attach:
        media = (f'<video src="{attach}" controls playsinline preload="metadata"></video>' if attach.endswith(".mp4")
                 else f'<img src="{attach}" alt="">')
    page += (f'<div class="post"><div class="av">H</div><div class="body"><div class="who"><b>Hanqi Xiao</b> '
             f'<span>· {i}/{total}</span></div><div class="txt">{body(text)}</div>{media}'
             f'<div class="count">{n} / {LIMIT}</div></div></div>')
page += "</main></body></html>"
open(OUT, "w", encoding="utf-8").write(page)
for i, total, attach, text, n in posts:
    print(f"{i:>2}/{total}  {n:>3}  {'OVER' if n > LIMIT else ''}")
