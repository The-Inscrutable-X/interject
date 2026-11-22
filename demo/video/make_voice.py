"""Record each narration line with macOS's built-in `say` voice.

Usage: python make_voice.py [VOICE]      (default: Samantha)
Reads narration.json next to this file and writes vo/<VOICE>_<key>.wav (48 kHz).
render.py trims the silence and evens out the loudness of each clip.
"""
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
voice = sys.argv[1] if len(sys.argv) > 1 else "Samantha"
os.makedirs(os.path.join(HERE, "vo"), exist_ok=True)
for key, text in json.load(open(os.path.join(HERE, "narration.json"))).items():
    out = os.path.join(HERE, "vo", f"{voice}_{key}.wav")
    rate = "165" if key.startswith("t") else "178"   # teaser lines (t1, t3, ...) a little slower
    subprocess.run(["say", "-v", voice, "-r", rate, "-o", out, "--file-format=WAVE",
                    "--data-format=LEI16@48000", text], check=True)
    print(key, text)
