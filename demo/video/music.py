"""Synthesize a quiet ambient music bed: soft pad chords, a low root, sparse high
plucks, and a simple reverb. Usage: python music.py DURATION OUT.wav"""
import sys, wave
import numpy as np
from scipy.signal import fftconvolve, butter, sosfilt

SR = 48000
dur = float(sys.argv[1]); out = sys.argv[2]
n = int(dur * SR); t = np.arange(n) / SR
rng = np.random.default_rng(7)

def hz(m): return 440.0 * 2 ** ((m - 69) / 12)

# I - vi - IV - V(sus) in D major, rich voicings; 8 s per chord.
CHORDS = [[50, 57, 61, 64, 66], [47, 54, 57, 61, 62], [43, 50, 54, 57, 59], [45, 52, 59, 61, 66]]
SEG = 8.0
L = np.zeros(n); R = np.zeros(n)

def env(start, length, att=2.2, rel=3.0):
    e = np.zeros(n)
    i0 = int(start * SR); i1 = min(n, int((start + length + rel) * SR))
    if i0 >= n: return e
    tt = (np.arange(i0, i1) - i0) / SR
    a = np.clip(tt / att, 0, 1) ** 2
    r = np.clip((start + length + rel - (tt + start)) / rel, 0, 1)
    r = np.where(tt < length, 1.0, r)
    e[i0:i1] = (0.5 - 0.5 * np.cos(np.pi * a)) * r
    return e

k = 0; s = 0.0
while s < dur:
    ch = CHORDS[k % 4]
    e = env(s, SEG)
    for j, m in enumerate(ch):
        f = hz(m)
        for det, pan in ((0.9985, 0.3), (1.0, 0.5), (1.0015, 0.7)):
            ph = rng.uniform(0, 2 * np.pi)
            w = np.sin(2 * np.pi * f * det * t + ph) + 0.12 * np.sin(4 * np.pi * f * det * t + ph)
            amp = 0.05 if j else 0.07
            L += amp * e * w * (1 - pan); R += amp * e * w * pan
    root = hz(ch[0])
    b = 0.05 * e * np.sin(2 * np.pi * root * t)
    L += b; R += b
    # sparse high plucks from the chord, two per chord
    for p in range(2):
        ts = s + 1.5 + p * 4.0 + rng.uniform(-0.3, 0.3)
        if ts >= dur - 1: continue
        m = ch[rng.integers(1, len(ch))] + 24
        i0 = int(ts * SR); i1 = min(n, i0 + int(3.0 * SR))
        tt = (np.arange(i0, i1) - i0) / SR
        pl = 0.035 * np.exp(-tt / 0.7) * (np.sin(2 * np.pi * hz(m) * tt) + 0.2 * np.sin(6 * np.pi * hz(m) * tt)) * np.clip(tt / 0.01, 0, 1)
        pan = 0.3 if p == 0 else 0.7
        L[i0:i1] += pl * (1 - pan); R[i0:i1] += pl * pan
    k += 1; s += SEG

# slow breathing
lfo = 0.85 + 0.15 * np.sin(2 * np.pi * 0.07 * t)
L *= lfo; R *= lfo
# reverb: decaying noise impulse
ir_len = int(3.2 * SR); it = np.arange(ir_len) / SR
irL = rng.standard_normal(ir_len) * np.exp(-it / 0.55); irR = rng.standard_normal(ir_len) * np.exp(-it / 0.55)
lp = butter(2, 3500, "low", fs=SR, output="sos")
irL = sosfilt(lp, irL); irR = sosfilt(lp, irR)
irL /= np.sqrt((irL ** 2).sum()); irR /= np.sqrt((irR ** 2).sum())
wL = fftconvolve(L, irL)[:n]; wR = fftconvolve(R, irR)[:n]
L = 0.7 * L + 0.45 * wL; R = 0.7 * R + 0.45 * wR
soft = butter(2, 5000, "low", fs=SR, output="sos")
hp = butter(2, 80, "high", fs=SR, output="sos")
L = sosfilt(hp, sosfilt(soft, L)); R = sosfilt(hp, sosfilt(soft, R))
# fades
fi = np.clip(t / 2.5, 0, 1); fo = np.clip((dur - t) / 4.0, 0, 1)
L *= fi * fo; R *= fi * fo
peak = max(np.abs(L).max(), np.abs(R).max())
L, R = L / peak * 0.7, R / peak * 0.7
data = (np.stack([L, R], 1) * 32767).astype(np.int16)
w = wave.open(out, "wb"); w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(data.tobytes()); w.close()
print("music", dur, "s ->", out)
