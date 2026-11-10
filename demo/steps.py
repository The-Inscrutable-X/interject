import re, time

QUESTION = 'In 5 short numbered steps, how does a sourdough starter work? One line each, no intro.'


def start(t):
    """Past any trust dialog, to an empty prompt."""
    end = time.time() + 60
    while time.time() < end:
        txt = t.text()
        if 'trust' in txt.lower() and ('Yes' in txt or 'proceed' in txt.lower()):
            t.snap('trust dialog')
            t.key('down')
            time.sleep(0.3)
            t.key('enter')
            time.sleep(2)
            continue
        if '>' in txt or '❯' in txt:
            t.settle(2.0)
            return
        time.sleep(0.5)
    t.snap('no prompt')


def ask(t, text):
    t.type(text, delay=0.02)
    t.pause(0.4)
    t.key('enter')


def wait_reply(t, timeout=120):
    # Wait for the reply to stop changing.
    time.sleep(3)
    t.settle(4.0, timeout)


def explore(t):
    start(t)
    t.snap('started')
    ask(t, QUESTION)
    wait_reply(t)
    t.snap('replied')
    t.select_text(r'[Ff]eed', last=False)
    time.sleep(1.5)
    t.snap('selected')
    t.click_text('Interject here')
    time.sleep(2)
    t.snap('form open')


def interject_at(t, line_pattern, question, button=None, last=False):
    """Select a line, press ✎, type the question, then Enter or a button."""
    t.select_line(line_pattern, last=last)
    t.pause(1.2)
    t.click_text(r'✎ Interject here')
    t.wait_for(r'Your question or note|Ask on the side', 15)
    t.pause(0.8)
    t.type(question)
    t.pause(0.7)
    if button is None:
        t.key('enter')
    else:
        t.click_text(re.escape(button))


def wait_answered(t, timeout=180):
    t.pause(1.5)
    t.wait_gone(r'Working on it on the side|Thinking…', timeout)
    t.settle(1.5, 30)


def demo(t):
    start(t)
    t.snap('started')
    t.pause(1)
    ask(t, QUESTION)
    wait_reply(t)
    t.snap('1 replied')
    t.pause(1.5)

    # 1. A side question at a line: answered in a box there, not in the conversation.
    interject_at(t, r'^\s*4\. ', 'Why does that matter? One sentence.')
    t.snap('2 asked on the side')
    wait_answered(t)
    t.snap('3 side answer')
    t.pause(2.5)

    # 2. Nesting: interject on a line of the side answer.
    hit = t.find(r'╭')
    lines = t.lines()
    target = next(i for i in range(hit[0] + 2, len(lines)) if len(lines[i].strip('│ ').strip()) > 30)
    words = lines[target].strip('│ ').strip()[:25]
    interject_at(t, re.escape(words), 'What is a healthy pH for it? Short.', button='Quick answer (no tools)')
    t.snap('4 nested asked')
    wait_answered(t)
    t.snap('5 nested answer')
    t.pause(2.5)

    # 3. Keep the nested answer: it goes with the next message.
    t.click_text(r'\bkeep\b')
    t.pause(2)
    t.snap('6 kept')

    # 4. Add a note to the next message, at another line.
    interject_at(t, r'^\s*5\. ', 'I use rye flour.', button='Add to my next message')
    t.pause(2.5)
    t.snap('7 added to next message')

    # 5. Cut and continue at line 2.
    t.scroll_to(r'^\s*3\. ')
    t.pause(1)
    interject_at(t, r'^\s*3\. ', 'Skip the science: how many days until it is ready?', button='Cut here and continue')
    t.pause(4)
    t.snap('8 cut sent')
    wait_reply(t)
    t.pause(3)
    t.snap('9 continued')


def debug_nest(t):
    start(t)
    ask(t, QUESTION)
    wait_reply(t)
    interject_at(t, r'feedings', 'Why do regular feedings matter? One sentence.')
    wait_answered(t)
    hit = t.find(r'╭')
    lines = t.lines()
    r = next(i for i in range(hit[0] + 2, len(lines)) if len(lines[i].strip('│ ').strip()) > 30)
    t.select_line(re.escape(lines[r].strip('│ ').strip()[:25]))
    t.pause(1.5)
    t.snap('after nested select, row %d' % r)
    import subprocess
    t.log.write('CLIPBOARD: ' + repr(subprocess.run(['pbpaste'], capture_output=True, text=True).stdout) + '\n')


def debug_cut(t):
    start(t)
    ask(t, QUESTION)
    wait_reply(t)
    interject_at(t, r'^\s*3\. ', 'How many days until ready?', button='Cut here and continue')
    t.pause(3)
    wait_reply(t)
    t.snap('cut done')
