"""Drive an interactive Claude Code session in a pty, record it as an asciicast.

Usage: venv/bin/python drive.py <script-name> <out.cast> <workdir>
The script is a function in steps.py taking a Term.
"""
import json, os, pty, re, select, signal, sys, threading, time

import pyte

COLS, ROWS = 104, 34


class Term:
    def __init__(self, argv, cwd, cast_path, log_path):
        self.screen = pyte.Screen(COLS, ROWS)
        self.stream = pyte.ByteStream(self.screen)
        self.lock = threading.Lock()
        self.t0 = time.time()
        self.cast = open(cast_path, 'w')
        self.cast.write(json.dumps({'version': 2, 'width': COLS, 'height': ROWS, 'timestamp': int(self.t0),
                                    'env': {'TERM': 'xterm-256color', 'SHELL': '/bin/zsh'}}) + '\n')
        self.log = open(log_path, 'w')
        self.last_output = time.time()
        import codecs
        self.decoder = codecs.getincrementaldecoder('utf-8')('replace')
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(cwd)
            # A clean environment, as a terminal of the user's own would give.
            keep = ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR',
                    'CLAUDE_CODE_PLUGIN_DIRS', 'CLAUDE_CODE_PLUGIN_DIR_WATCH']
            os.environ['DISABLE_AUTOUPDATER'] = '1'
            keep.append('DISABLE_AUTOUPDATER')
            env = {k: os.environ[k] for k in keep if k in os.environ}
            env.update(TERM='xterm-256color', COLORTERM='truecolor', COLUMNS=str(COLS), LINES=str(ROWS))
            os.execvpe(argv[0], argv, env)
        self.pid, self.fd = pid, fd
        import fcntl, struct, termios
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
        self.alive = True
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        while self.alive:
            r, _, _ = select.select([self.fd], [], [], 0.1)
            if not r:
                continue
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                self.alive = False
                break
            if not data:
                self.alive = False
                break
            with self.lock:
                self.stream.feed(data)
                self.last_output = time.time()
                self.cast.write(json.dumps([round(time.time() - self.t0, 4), 'o', self.decoder.decode(data)]) + '\n')
                self.cast.flush()
            # Answer terminal queries the TUI makes (cursor position, device attributes).
            if b'\x1b[6n' in data:
                y, x = self.screen.cursor.y + 1, self.screen.cursor.x + 1
                os.write(self.fd, f'\x1b[{y};{x}R'.encode())
            if b'\x1b[c' in data or b'\x1b[0c' in data:
                os.write(self.fd, b'\x1b[?62;22c')

    # ---- reading the screen
    def lines(self):
        with self.lock:
            return [self.screen.display[i] for i in range(ROWS)]

    def text(self):
        return '\n'.join(self.lines())

    def snap(self, label):
        self.log.write(f'\n===== {label} t={time.time() - self.t0:.1f}\n' + self.text() + '\n')
        self.log.flush()

    def find(self, pattern, last=False):
        """(row, col) 0-based of the first (or last) regex match on screen, or None."""
        hits = []
        for r, line in enumerate(self.lines()):
            for m in re.finditer(pattern, line):
                hits.append((r, m.start(), m.end()))
        if not hits:
            return None
        return hits[-1] if last else hits[0]

    def wait_for(self, pattern, timeout=120, last=False):
        end = time.time() + timeout
        while time.time() < end:
            hit = self.find(pattern, last)
            if hit:
                return hit
            time.sleep(0.2)
        self.snap('TIMEOUT waiting for ' + pattern)
        raise TimeoutError(pattern)

    def wait_gone(self, pattern, timeout=180):
        end = time.time() + timeout
        while time.time() < end:
            if not self.find(pattern):
                return
            time.sleep(0.3)
        self.snap('TIMEOUT waiting for gone ' + pattern)
        raise TimeoutError('gone ' + pattern)

    def settle(self, quiet=1.0, timeout=30):
        end = time.time() + timeout
        while time.time() < end:
            if time.time() - self.last_output > quiet:
                return
            time.sleep(0.1)

    # ---- input
    def send(self, s):
        os.write(self.fd, s.encode() if isinstance(s, str) else s)

    def type(self, s, delay=0.045):
        for ch in s:
            self.send(ch)
            time.sleep(delay)

    def key(self, name):
        keys = {'enter': '\r', 'esc': '\x1b', 'up': '\x1b[A', 'down': '\x1b[B', 'tab': '\t'}
        self.send(keys[name])

    def mouse(self, kind, row, col):
        # SGR mouse, 1-based. kind: press, drag, release
        b = {'press': 0, 'drag': 32, 'release': 0}[kind]
        end = 'm' if kind == 'release' else 'M'
        self.send(f'\x1b[<{b};{col + 1};{row + 1}{end}')

    def drag(self, row, c0, c1):
        self.mouse('press', row, c0)
        time.sleep(0.08)
        steps = 8
        for i in range(1, steps + 1):
            self.mouse('drag', row, c0 + (c1 - c0) * i // steps)
            time.sleep(0.04)
        self.mouse('release', row, c1)

    def click(self, row, col):
        self.mouse('press', row, col)
        time.sleep(0.06)
        self.mouse('release', row, col)

    def click_text(self, pattern, last=False, timeout=30):
        r, c0, c1 = self.wait_for(pattern, timeout, last)
        self.click(r, (c0 + c1) // 2)
        return r

    def select_line(self, pattern, last=False, timeout=30):
        """Drags across the whole screen line the pattern is on, from its first to its last character."""
        r, _, _ = self.wait_for(pattern, timeout, last)
        line = self.lines()[r]
        body = re.sub(r'^[\s│▎⏺]*', '', line)
        c0 = len(line) - len(body)
        c1 = len(line.rstrip().rstrip('│').rstrip()) - 1
        self.drag(r, c0, c1)
        return r

    def select_text(self, pattern, last=False, timeout=30):
        r, c0, c1 = self.wait_for(pattern, timeout, last)
        self.drag(r, c0, c1 - 1)
        return r

    def wheel(self, up=True, n=3, row=12, col=40):
        for _ in range(n):
            self.send(f'\x1b[<{64 if up else 65};{col + 1};{row + 1}M')
            time.sleep(0.05)

    def scroll_to(self, pattern, up=True, tries=12):
        for _ in range(tries):
            if self.find(pattern):
                return
            self.wheel(up)
            time.sleep(0.4)
        raise TimeoutError('scroll to ' + pattern)

    def pause(self, s):
        time.sleep(s)

    def close(self):
        self.alive = False
        try:
            os.kill(self.pid, signal.SIGTERM)
        except OSError:
            pass
        self.cast.close()
        self.log.close()


if __name__ == '__main__':
    import steps
    name, cast, workdir = sys.argv[1], sys.argv[2], sys.argv[3]
    argv = ['claude', '--model', os.environ.get('DEMO_MODEL', 'sonnet')] + (['--plugin-dir', os.environ['DEMO_PLUGIN']] if os.environ.get('DEMO_PLUGIN') else [])
    t = Term(argv, workdir, cast, cast.replace('.cast', '.log'))
    try:
        getattr(steps, name)(t)
    except Exception as e:
        t.snap('ERROR ' + repr(e))
        raise
    finally:
        t.snap('END')
        t.close()
