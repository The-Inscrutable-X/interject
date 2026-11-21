# Interject launch thread (draft)

A draft of the launch thread for X. Copy each post from below. The pictures and `interject-teaser.mp4` (the video for post 1) are in this folder; `../video/make_thread_images.py` and `STORY=teaser python ../video/render.py full ...` rebuild them.
Open `preview.html` next to this file to see the thread with its pictures. After editing a post, run `python ../video/make_thread_preview.py`: it recounts each post the way X does (a link is 23, an emoji or a symbol like • is 2) and rebuilds the preview.

## Before posting

- Upload interject-teaser.mp4 to post 1 and the pictures to their posts.
- After posting, pin the thread to your profile.

## Why it is shaped this way

What the research says works for a launch thread, and how this draft follows it.
These come from growth blogs and tool makers, not from X, so treat them as good habits rather than proven rules.

- The first post decides whether anyone opens the rest. It names a pain the reader has felt, says what you built, and names only the most important features. Post 1 does this.
- Put a short video on the first post: under about 45 seconds, starting on the result, with captions burned in, because X plays video muted. interject-teaser.mp4 is 35 seconds, opens on a real reply, has subtitles, and ends by telling people to ask Claude to install it. The 3-minute demo is too long for X unless the account has Premium (the limit is 2 min 20 s without it).
- One idea per post, each with a picture. Pictures are 16:9, so X shows them uncropped, and they are cropped tight so the text reads on a phone.
- 7 to 12 posts tends to do best. This draft has 12.
- Be honest about limits near the end. It builds trust with technical readers.
- Put links at the end. Sources disagree on whether X shows posts with links to fewer people; links in the last posts are safe either way.
- End with a clear ask: try it, send feedback, repost the first post.
- Timing and the first hour: post on a weekday morning (Eastern time), and stay for the first hour to answer replies. X weighs replies far more than likes.

## Other first lines to try

1. Ever get lost halfway through a long Claude reply? (used in the draft)
2. Claude wrote you 2,000 words. You're stuck on line 40. Now what?
3. I kept losing my place in long Claude replies, so I built a way to ask about any line, right where I'm reading.
4. What if you could stop Claude at any line of its reply and ask "wait, what does that mean?"
5. Side chats float away and replies scroll off. I wanted my questions to stay where I asked them.

## The thread

### 1/12  (276 of 280 characters, attach interject-teaser.mp4)

```
Ever get lost halfway through a long Claude reply?

I built Interject, a Claude Code mod. Stop at any line and:
• send an agent with full tool use
• keep its answer for your next message
• cut, and Claude rewrites from there

Everything stays inline, not floating away.

🧵
```

### 2/12  (231 of 280 characters, attach 2-answer-stays-at-the-line.jpg)

```
Claude Code already has side chats and replies. But their answers float away from the line you asked about.

With Interject, each question lives in a box right under its line. You always know where to look, what you asked, and why.
```

### 3/12  (154 of 280 characters, attach 3-four-choices.jpg)

```
Select any text in a reply, even while Claude is still writing, and click ✎ Interject here.

A small form opens right under that line, with four choices.
```

### 4/12  (230 of 280 characters, attach 4-side-answer-and-follow-up.jpg)

```
Ask on the side sends a forked agent with the whole conversation and full tool use. It can read files, run commands and search the web. Nothing is added to your main conversation.

No tools needed? Quick answer replies in seconds.
```

### 5/12  (186 of 280 characters, attach 5-nested.jpg)

```
Follow up on any answer, and the follow-up sits right under it.

Or select a line inside an answer and interject again, as deep as you need. Each new question carries the chain above it.
```

### 6/12  (156 of 280 characters, attach 6-keep.jpg)

```
Found something useful? Keep it.

Kept answers and notes go with your next message, along with the boxes they build on. A line above the prompt counts them.
```

### 7/12  (92 of 280 characters, attach 7-see-what-is-sent.jpg)

```
No guessing what Claude sees: click show to read the exact text that goes with your message.
```

### 8/12  (131 of 280 characters, attach 8-cut.jpg)

```
Reply going off track? Cut here and continue.

Claude drops the rest of the reply and rewrites from that line, following your note.
```

### 9/12  (148 of 280 characters, attach 10-fork.jpg)

```
Any side chat can become a session of its own.

In Claude Code Desktop, it's listed under the original session, and the original hears back from it.
```

### 10/12  (276 of 280 characters)

```
Limits: it's a mod, so some parts are workarounds:
• A cut sends a new message, and the old reply stays in history
• Outside bypass mode, side chats and forks run in a separate terminal Claude
• Made for Desktop. VS Code has no ✎ button
• Side chats use your plan's usage
```

### 11/12  (195 of 280 characters)

```
Interject is free and open source (MIT).

Ask your Claude to install it in Claude Code, or type:
/plugin install interject --marketplace The-Inscrutable-X/interject

Code: github.com/The-Inscrutable-X/interject
```

### 12/12  (240 of 280 characters)

```
This is a small side tool that I made by myself, mostly for myself.

The full write-up, with a 3-minute demo: hanqixiao.github.io/blog/posts/interject/interject.html

Feedback and bug reports welcome. If it's useful to you, a repost of the first post helps others find it.
```

## Sources

- [How to Write a Viral Twitter Thread (2026): hook, structure, examples](https://xholic.ai/guides/how-to-write-a-viral-twitter-thread/)
- [X Launch Video Strategy Guide for 2026](https://www.atomikgrowth.com/blog/x-launch-video-strategy-guide-for-2026-specs-to-strategy)
- [How to Do a Viral Launch on X (2026)](https://okara.ai/viral-launch-x-handbook)
- [How to Write X/Twitter Threads That Go Viral](https://xagently.com/en/blog/how-to-write-x-threads)
- [X Algorithm 2026: How It Ranks Posts, From X's Own Code](https://xholic.ai/blog/x-algorithm/)
- [How to Post Links on X in 2026 Without Losing Reach](https://reachmore.co/blogs/how-to-post-links-on-x-2026)
- [X (Twitter) Algorithm: Ranking Factors and Growth Tips (2026)](https://www.socialpilot.co/blog/twitter-algorithm)
