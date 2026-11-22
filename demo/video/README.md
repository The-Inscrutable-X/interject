# How the demo video is made

These scripts turn a raw screen recording of Claude Code Desktop into the
narrated demo, `demo/interject-desktop-demo.mp4`, and the pictures in
`demo/stills/`.

## What each file does

- `narration.json`: the words of the voiceover, one short line per key.
- `make_voice.py`: records each line with the built-in macOS voice
  (Samantha) into `vo/`.
- `music.py`: makes the quiet background music from scratch (soft chords,
  a few high notes, and some echo), so there is nothing to license.
- `render.py`: builds the video. It decides which parts of the recording to
  keep and at what speed, where the camera looks, where the orange boxes
  go, and when each line is spoken. Everything it needs to know is in the
  `CHAPTERS` list at the top. When the video reaches a moment that a line
  describes while the previous line is still being spoken, it holds that
  frame until the voice is free, so words and pictures stay in step. It then
  mixes the voice with the music, turning the music down while someone
  speaks.
- `make_stills.py`: exports one picture per feature, in the same style. Each
  picture has a "You click" strip, cut from the real form at the moment of
  the click, with the clicked button boxed.
- `make_thread_images.py`: exports 16:9 pictures for a social media thread,
  cropped tight so the text reads on a phone.
- `make_thread_preview.py`: recounts the X thread posts in `demo/thread/thread.md`
  the way X counts them and rebuilds `demo/thread/preview.html`.
- `make_poster.py`: makes the still picture shown before the video plays.

## Running it

You need macOS (for the `say` voice), `ffmpeg`, and a Python with
`numpy`, `scipy`, `opencv-python` and `Pillow`. The raw recording is not
in the repository (it is 440 MB). Put it at
`demo/raw/screen-recording-2026-11-20.mov`, or point `RAW` at it.

```bash
cd demo/video
python make_voice.py
python render.py draft draft.mp4
python render.py full ../interject-desktop-demo.mp4
python make_stills.py ../raw/screen-recording-2026-11-20.mov ../stills
```

For the 42-second teaser (for the first post of a thread), set `STORY=teaser`:

```bash
STORY=teaser python render.py full teaser.mp4
```

`draft` renders at 10 frames per second for a quick look. `full` renders at
30. `python render.py timing x.mp4` prints when each line is spoken and where
the video holds a frame, without rendering anything.

Times in `CHAPTERS` are seconds in the raw recording. Rows and boxes are
in the chat column of the recording, in its own pixels.
