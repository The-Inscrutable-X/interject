import { expect, mock, test } from 'claude-code/testing'

const REPLY = [
  'First, the rig records video.',
  '',
  'Then the **feeder** turns the plate.',
  '',
  'Finally the server saves the run.',
].join('\n')

const LINE = 'Then the feeder turns the plate.'

const MESSAGE = (surface: 'terminal' | 'desktop' | 'vscode') =>
  ({
    plugin: 'interject',
    surface,
    component: 'AssistantMessage',
    requestId: 'm1',
    props: { text: REPLY, isFirstOfReply: true },
  }) as const

const PANE = (surface: 'terminal' | 'desktop' | 'vscode') =>
  ({
    plugin: 'interject',
    surface,
    component: 'Pane',
    requestId: 'interject',
    props: {
      title: 'Interject',
      isFocused: true,
      bodyColumns: 60,
      placement: 'inline',
      scroll: { offset: 0, bodyRows: 12 },
      view: {},
    },
  }) as const

const BAND = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'interject',
    surface,
    component: 'AbovePrompt',
    requestId: 'above-prompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 6 }, view: {} },
  }) as const

/** A message row of the person's: `text` as stored, from `origin`. */
const USER = (
  surface: 'terminal' | 'desktop',
  text: string,
  origin: { kind: 'composer' } | { kind: 'plugin'; name: string },
  isExpanded: boolean,
) =>
  ({
    plugin: 'interject',
    surface,
    component: 'UserMessage',
    requestId: 'u1',
    props: { text, origin, isExpanded },
  }) as const

/** What the mod added under the person's message, as one text; empty when it added nothing. */
function attachedOf(text: string): string[] {
  const m = /\n\n\[interject: \d+ box(?:es)? attached to this message\]\n/.exec(text)
  return m === null ? [] : [text.slice(m.index + m[0].length)]
}

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type On = Parameters<Parameters<typeof test>[1]>[1]
type World = ReturnType<typeof engine>['world']

/** The world of the test running now, for the helpers below. */
let last: World

/** The world beneath the plugin, drawing on `surface`. `world.selection` is what the mouse last selected. */
function engine(on: On, surface: 'terminal' | 'desktop' | 'vscode' = 'terminal', store?: Map<string, unknown>) {
  const world: {
    selection?: { text: string; requestId?: string }
    answers: string[]
    forkPrompts: string[]
    opened: string[]
    closed: string[]
    draws: number
    /** Each side chat's agent, as spawned: its id, its type, and whether it has ended. */
    agents: { agentId: string; type: string; isDone: boolean }[]
    /** The tool calls that reached the engine, by tool name. */
    tools: { tool: string; input: Record<string, unknown> }[]
    submitted: string[]
    /** How many spawns to deny before one starts, as auto mode's classifier can. */
    denySpawns: number
    spawnTries: number
    /** Whether starting a session at once is refused, as from a press on a box. */
    startOnlyOnWords?: boolean
    /** Whether auto mode's check refuses the app's session tool, as with no allow rule for it. */
    sessionToolDenied?: boolean
    /** What a headless fork writes, line by line; absent, starting one fails. */
    childLines?: string[]
    /** Each process started, by its argv. */
    children: string[][]
    /** The files the mod wrote, by absolute path. */
    files: Map<string, string>
    /** The notices the mod showed. */
    toasts: string[]
    /** The session's id: changed by a test, as a resume or /clear inside the process changes it. */
    sessionId: string
  } = {
    answers: [],
    forkPrompts: [],
    opened: [],
    closed: [],
    draws: 0,
    agents: [],
    tools: [],
    submitted: [],
    denySpawns: 0,
    spawnTries: 0,
    children: [],
    files: new Map(),
    toasts: [],
    sessionId: 's1',
  }
  last = world
  mock.env(on, { HOME: '/home/t' })
  // The file system, in memory: what the mod's saving reads and writes.
  on('fs.write', (_, e) => {
    world.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const text = world.files.get(e.path)
    return text === undefined ? ({ deny: 'ENOENT: ' + e.path } as never) : { value: text }
  })
  on('fs.exists', (_, e) => ({ value: [...world.files.keys()].some(f => f === e.path || f.startsWith(e.path + '/')) }))
  on('fs.list', (_, e) => {
    const rest = [...world.files.keys()].filter(f => f.startsWith(e.path + '/')).map(f => f.slice(e.path.length + 1))
    const names = new Set(rest.map(r => r.split('/')[0] ?? ''))
    const kind = (name: string) => (rest.some(r => r.startsWith(name + '/')) ? 'dir' : 'file')
    return { value: [...names].map(name => ({ name, kind: kind(name), size: 0, mtimeMs: 0, isLink: false })) as never }
  })
  const clock = mock.clock(on)
  if (store === undefined) mock.store(on)
  else {
    // A store the test can read, refusing a set past 4 MiB of JSON in all, as the engine's does.
    const size = (m: Map<string, unknown>) => [...m.values()].reduce((n: number, v) => n + JSON.stringify(v).length, 0)
    on('store.get', (_, e) => ({ value: store.get(e.key) }))
    on('store.keys', () => ({ value: [...store.keys()] }))
    on('store.delete', (_, e) => {
      store.delete(e.key)
      return { value: undefined }
    })
    on('store.set', (_, e) => {
      const next = new Map(store).set(e.key, JSON.parse(JSON.stringify(e.value)))
      if (size(next) > 4 * 1024 * 1024) return { deny: 'The store is over 4 MiB' } as never
      store.set(e.key, next.get(e.key))
      return { value: undefined }
    })
  }
  on('command.register', () => ({ value: { command: 'interject' } }))
  on('ui.open', (_, e) => {
    world.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    world.closed.push(e.id)
    return { value: undefined }
  })
  on('session.surfaces', () => ({ value: [surface] }))
  on('ui.toast', (_, e) => {
    world.toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('ui.selection', () => ({ value: world.selection }))
  on('session.id', () => ({ value: world.sessionId }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.messages', () => ({ value: [{ role: 'assistant', text: REPLY, toolUses: [] }] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('model.fork', (_, e) => {
    world.forkPrompts.push(e.prompt)
    return { value: { isAnswered: true, text: world.answers.shift() ?? 'An answer.', usage: USAGE } }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  // A side chat is an agent, launched in the background and ended by `finish`.
  // The kit hands a plugin's spawn on in the Agent tool's field names.
  on('agent.spawn', async (_, e) => {
    const input = e as unknown as Record<string, unknown>
    world.spawnTries += 1
    if (world.denySpawns > 0) {
      world.denySpawns -= 1
      return { deny: 'The server-side auto mode classifier gave no verdict for Agent.' } as never
    }
    const agentId = 'agent-' + (world.agents.length + 1)
    world.forkPrompts.push(String(input.prompt))
    world.agents.push({ agentId, type: String(input.subagent_type ?? input.subagentType), isDone: false })
    const result = { status: 'async_launched', agentId, description: input.description, prompt: input.prompt }
    return { model: 'claude-opus-5-5', agentId, result, text: 'Launched ' + agentId } as never
  })
  // A headless Claude Code fork: what it writes, then how it ended.
  on('process.spawn', async function* (_, e) {
    world.children.push([...e.argv])
    if (world.childLines === undefined) return { deny: 'claude: command not found' } as never
    for (const line of world.childLines) yield { stream: 'stdout' as const, text: line + '\n' }
    return { value: { code: 0, signal: null } } as never
  })
  on('tool.call', (_, e) => {
    const input = e as unknown as Record<string, unknown>
    world.tools.push({ tool: e.tool, input })
    if (world.sessionToolDenied && e.tool === 'mcp__ccd_session__start_session') {
      return { deny: 'The server-side auto mode classifier gave no verdict for mcp__ccd_session__start_session' } as never
    }
    // As Desktop does outside a turn the person's own typed message began.
    if (world.startOnlyOnWords && e.tool === 'mcp__ccd_session__start_session' && input.initiation === 'user_asked') {
      return { result: {}, text: "Start sessions only on the user's own words to you here", isError: true } as never
    }
    return { result: {}, text: 'done' } as never
  })
  on('ui.render', ($, e) => {
    world.draws += 1
    const { Text } = $.ui.resolve(e)
    return <Text>engine: {String((e.props as { text?: string }).text ?? '')}</Text>
  })
  return { world, clock }
}

/** Starts the session and draws the reply once, as a session does before anyone selects in it. */
async function begin($: Parameters<Parameters<typeof test>[1]>[0], surface: 'terminal' | 'desktop' | 'vscode') {
  await $.session.start({ cwd: '/', surface, isInteractive: true })
  const before = await $.ui.mount(MESSAGE(surface))
  await before.unmount()
}

/**
 * Opens the form by /interject, types `question`, and presses `button` (or
 * Enter for 'enter'): in the panel on the terminal, under the line elsewhere.
 */
async function interject(
  $: Parameters<Parameters<typeof test>[1]>[0],
  surface: 'terminal' | 'desktop' | 'vscode',
  question: string,
  button: 'enter' | 'quick' | 'queue' | 'cut',
) {
  await $.command.run({ command: 'interject', args: '' })
  const pane = await $.ui.mount(surface === 'terminal' ? PANE(surface) : MESSAGE(surface))
  if (button === 'enter') {
    await pane.input({ key: 'question', text: question, kind: 'submit' })
  } else {
    await pane.input({ key: 'question', text: question, kind: 'change' })
    await pane.press({ key: button })
  }
  await pane.unmount()
  await finish($)
}

/** Ends every side chat's agent still working, each with the next of `world.answers`. */
async function finish($: Parameters<Parameters<typeof test>[1]>[0]) {
  for (const agent of last.agents.filter(a => !a.isDone)) {
    agent.isDone = true
    await $.turn.complete({
      agentId: agent.agentId,
      turnId: 'turn-' + agent.agentId,
      answer: last.answers.shift() ?? 'An answer.',
      durationMs: 1,
      isAborted: false,
      reason: 'answer',
    })
  }
}

async function firstKey(message: { findAll: (q: { type: 'Button' }) => Promise<{ key?: string }[]> }, prefix: string) {
  const buttons = await message.findAll({ type: 'Button' })
  return buttons.map(b => b.key ?? '').find(k => k.startsWith(prefix)) ?? ''
}

for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
  test(`a reply with no interjection is drawn by the engine (${surface})`, async ($, on) => {
    engine(on, surface)
    const ui = await $.ui.mount(MESSAGE(surface))
    expect((await ui.find({ type: 'Text', text: /engine:/ }))?.text).toContain('Finally')
    await ui.unmount()
  })

  test(`add to next message: a box at the line, then context on the next prompt (${surface})`, async ($, on) => {
    const { world } = engine(on, surface)
    world.selection = { text: LINE, requestId: 'm1' }
    let sentContext: readonly string[] = []
    let sentText = ''
    on('prompt.submit', (_, e) => {
      sentContext = attachedOf(e.text)
      sentText = e.text
      return { text: e.text, context: e.context }
    })
    await begin($, surface)
    await interject($, surface, 'Which plate?', 'queue')

    const message = await $.ui.mount(MESSAGE(surface))
    expect(await message.find({ type: 'Text', text: /Which plate\?/ })).toBeDefined()
    expect(await message.find({ type: 'Text', text: /Will be attached to your next message/ })).toBeDefined()
    expect((await message.find({ type: 'Text', text: /engine:/ }))?.text).not.toContain('Finally')

    await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })
    expect(sentText.startsWith('go on\n\n[interject: 1 box attached to this message]\n')).toBe(true)
    expect(sentContext.length).toBe(1)
    expect(sentContext[0]).toContain('> Then the **feeder** turns the plate.')
    expect(sentContext[0]).toContain('Which plate?')

    await message.redraw()
    expect(await message.find({ type: 'Text', text: /Attached to your message/ })).toBeDefined()
    // The box shows what went with the message on a press, and folds it again.
    expect(await message.find({ type: 'Text', text: sentContext[0] ?? '' })).toBeUndefined()
    await message.press({ key: await firstKey(message, 'sent-') })
    expect(await message.find({ type: 'Text', text: sentContext[0] ?? '' })).toBeDefined()
    expect((await message.find({ key: await firstKey(message, 'sent-') }))?.props?.label).toBe('▴ hide what was sent')
    await message.press({ key: await firstKey(message, 'sent-') })
    expect(await message.find({ type: 'Text', text: sentContext[0] ?? '' })).toBeUndefined()
    await message.unmount()
  })

  test(`side question: answered in the box, nothing sent with the next prompt (${surface})`, async ($, on) => {
    const { world } = engine(on, surface)
    world.selection = { text: LINE, requestId: 'm1' }
    world.answers.push('The round feedplate.')
    let sentContext: readonly string[] | undefined
    on('prompt.submit', (_, e) => {
      sentContext = e.context
      return { text: e.text }
    })
    await begin($, surface)
    await interject($, surface, 'Which plate?', 'enter')

    expect(world.forkPrompts[0]).toContain('Which plate?')
    expect(world.forkPrompts[0]).toContain('First, the rig records video.')
    expect(world.forkPrompts[0]).not.toContain('Finally the server saves the run.')

    const message = await $.ui.mount(MESSAGE(surface))
    expect(await message.find({ type: 'Markdown', text: /round feedplate/ })).toBeDefined()

    await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })
    expect(sentContext).toBeUndefined()

    await message.press({ key: await firstKey(message, 'dismiss-') })
    expect(await message.find({ type: 'Markdown', text: /round feedplate/ })).toBeUndefined()
    await message.unmount()
  })

  test(`interject on an interjection: a box inside the side answer, with the chain (${surface})`, async ($, on) => {
    const { world } = engine(on, surface)
    world.selection = { text: LINE, requestId: 'm1' }
    world.answers.push('Use the round plate.\n\nIt sits under the tank.', 'The 40-litre tank.')
    on('prompt.submit', (_, e) => ({ text: e.text }))
    await begin($, surface)
    await interject($, surface, 'Which plate?', 'enter')

    // The answer is drawn, then a line of it is selected.
    const drawn = await $.ui.mount(MESSAGE(surface))
    await drawn.unmount()
    world.selection = { text: 'It sits under the tank.', requestId: 'm1' }
    await interject($, surface, 'Which tank?', 'enter')

    const prompt = world.forkPrompts[1] ?? ''
    expect(prompt).toContain('Earlier interjections')
    expect(prompt).toContain('Which plate?')
    expect(prompt).toContain('> It sits under the tank.')
    expect(prompt).toContain('Which tank?')

    const message = await $.ui.mount(MESSAGE(surface))
    // A box starts with its line, small and quoted, then the question with no mark before it.
    const line = await message.find({ type: 'Text', text: '“It sits under the tank.”' })
    expect(line?.props?.size).toBe('caption')
    expect(await message.find({ type: 'Text', text: 'Which tank?' })).toBeDefined()
    expect(await message.find({ type: 'Text', text: /^\? / })).toBeUndefined()
    expect(await message.find({ type: 'Markdown', text: /40-litre tank/ })).toBeDefined()
    await message.unmount()
  })

  test(`a box quotes just the part of the line that was selected (${surface})`, async ($, on) => {
    const { world } = engine(on, surface)
    world.selection = { text: 'the feeder\nturns', requestId: 'm1' }
    world.answers.push('The round plate.')
    await begin($, surface)
    await interject($, surface, 'Why?', 'enter')
    const message = await $.ui.mount(MESSAGE(surface))
    expect(await message.find({ type: 'Text', text: '“the feeder turns”' })).toBeDefined()
    expect(await message.find({ type: 'Text', text: '“' + LINE + '”' })).toBeUndefined()
    // A follow-up is about the same words.
    await message.press({ key: await firstKey(message, 'follow-') })
    await message.unmount()
    const form = await $.ui.mount(surface === 'terminal' ? PANE(surface) : MESSAGE(surface))
    await form.input({ key: 'question', text: 'And then?', kind: 'submit' })
    await form.unmount()
    await finish($)
    // The follow-up names the question it follows instead of quoting the line again.
    const again = await $.ui.mount(MESSAGE(surface))
    expect((await again.findAll({ type: 'Text', text: '“the feeder turns”' })).length).toBe(1)
    expect(await again.find({ type: 'Text', text: '↳ follows up: Why?' })).toBeDefined()
    await again.unmount()
  })

  test(`keep: a side answer goes with the next prompt (${surface})`, async ($, on) => {
    const { world } = engine(on, surface)
    world.selection = { text: LINE, requestId: 'm1' }
    world.answers.push('The round feedplate.')
    let sentContext: readonly string[] = []
    on('prompt.submit', (_, e) => {
      sentContext = attachedOf(e.text)
      return { text: e.text }
    })
    await begin($, surface)
    await interject($, surface, 'Which plate?', 'enter')

    const message = await $.ui.mount(MESSAGE(surface))
    await message.press({ key: await firstKey(message, 'keep-') })
    await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })
    expect(sentContext[0]).toContain('The round feedplate.')
    expect(sentContext[0]).toContain('Which plate?')
    await message.redraw()
    expect(await message.find({ type: 'Text', text: /Kept: attached/ })).toBeDefined()
    await message.unmount()
  })

  test(`keep: the boxes a kept box builds on say they go too, and each is sent once (${surface})`, async ($, on) => {
    const { world } = engine(on, surface)
    world.selection = { text: LINE, requestId: 'm1' }
    world.answers.push('Use the round plate.\n\nIt sits under the tank.', 'The tank.\n\nIt holds 40 litres.', 'Water.')
    let sentContext: readonly string[] = []
    on('prompt.submit', (_, e) => {
      sentContext = attachedOf(e.text)
      return { text: e.text }
    })
    await begin($, surface)
    await interject($, surface, 'Which plate?', 'enter')
    const first = await $.ui.mount(MESSAGE(surface))
    await first.unmount()
    world.selection = { text: 'It sits under the tank.', requestId: 'm1' }
    await interject($, surface, 'Which tank?', 'enter')
    const second = await $.ui.mount(MESSAGE(surface))
    await second.unmount()
    world.selection = { text: 'It holds 40 litres.', requestId: 'm1' }
    await interject($, surface, 'Of what?', 'enter')

    const message = await $.ui.mount(MESSAGE(surface))
    const keeps = async () => (await message.findAll({ type: 'Button' })).map(b => b.key ?? '').filter(k => k.startsWith('keep-'))
    expect((await keeps()).length).toBe(3)
    // Keep the outermost first, then the innermost: the middle one goes along.
    await message.press({ key: (await keeps()).at(-1) ?? '' })
    await message.press({ key: (await keeps())[0] ?? '' })
    expect(await keeps()).toEqual([])
    expect((await message.findAll({ type: 'Text', text: /^Kept: goes with/ })).length).toBe(2)
    expect((await message.findAll({ type: 'Text', text: /^Kept with a question built on it: goes with/ })).length).toBe(1)

    await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })
    const sent = sentContext.join('\n')
    for (const asked of ['Which plate?', 'Which tank?', 'Of what?']) {
      expect(sent.split('The user asked: ' + asked).length - 1).toBe(1)
    }
    await message.redraw()
    expect((await message.findAll({ type: 'Text', text: /^Kept with a question built on it: attached/ })).length).toBe(1)
    await message.unmount()
  })

  test(`dismiss: a box kept deep inside a dismissed box is not sent (${surface})`, async ($, on) => {
    const { world } = engine(on, surface)
    world.selection = { text: LINE, requestId: 'm1' }
    world.answers.push('Use the round plate.\n\nIt sits under the tank.', 'The tank.\n\nIt holds 40 litres.', 'Water.')
    let sentContext: readonly string[] = []
    on('prompt.submit', (_, e) => {
      sentContext = attachedOf(e.text)
      return { text: e.text }
    })
    await begin($, surface)
    await interject($, surface, 'Which plate?', 'enter')
    const first = await $.ui.mount(MESSAGE(surface))
    await first.unmount()
    world.selection = { text: 'It sits under the tank.', requestId: 'm1' }
    await interject($, surface, 'Which tank?', 'enter')
    const second = await $.ui.mount(MESSAGE(surface))
    await second.unmount()
    world.selection = { text: 'It holds 40 litres.', requestId: 'm1' }
    await interject($, surface, 'Of what?', 'enter')

    const message = await $.ui.mount(MESSAGE(surface))
    expect(await message.find({ type: 'Text', text: 'Of what?' })).toBeDefined()
    // A box's buttons follow the boxes inside it: the first keep is the
    // innermost box's, the last dismiss the outermost's.
    await message.press({ key: await firstKey(message, 'keep-') })
    expect(await message.find({ type: 'Text', text: /Kept: goes with/ })).toBeDefined()
    const dismisses = (await message.findAll({ type: 'Button' })).map(b => b.key ?? '').filter(k => k.startsWith('dismiss-'))
    expect(dismisses.length).toBe(3)
    await message.press({ key: dismisses.at(-1) ?? '' })
    expect(await message.find({ type: 'Text', text: 'Of what?' })).toBeUndefined()

    await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })
    expect(sentContext.join('\n')).not.toContain('Of what?')
    await message.unmount()
  })
}

test('boxes are saved in a folder per session, in pages, for every session; boxes in the store move there', async ($, on) => {
  const store = new Map<string, unknown>()
  const { world } = engine(on, 'terminal', store)
  world.selection = { text: LINE, requestId: 'm1' }
  on('prompt.submit', (_, e) => ({ text: e.text }))
  const box = (s: string, answer = 'a') => ({ id: s, requestId: 'm1', mode: 'side', status: 'answered', question: 'q ' + s, quote: LINE, answer })
  // What the store held before: this session's boxes and another's. This
  // session's are 120 boxes of 30 KB: more than a page (3 MiB) holds.
  const many = Array.from({ length: 120 }, (_, i) => box('b' + i, 'z'.repeat(30_000)))
  store.set('notes:s1', [box('mine'), ...many])
  store.set('notes:other', [box('theirs')])
  store.set('sessions', ['other', 's1'])
  const dir = '/home/t/.claude/interject-boxes'

  await begin($, 'terminal')
  // Moved out of the store, into the folder, and brought back here.
  expect([...store.keys()]).toEqual([])
  expect(world.files.get(dir + '/other/0.json')).toContain('q theirs')

  // Two pages, every box kept, and a new box saved after them.
  expect(world.files.has(dir + '/s1/1.json')).toBe(true)
  world.answers.push('An answer.')
  await interject($, 'terminal', 'Which plate?', 'enter')
  const page0 = JSON.parse(world.files.get(dir + '/s1/0.json') ?? '[]') as unknown[]
  const page1 = JSON.parse(world.files.get(dir + '/s1/1.json') ?? '[]') as unknown[]
  // Brought back, then saved again with the new box: 121 restored and 1 new.
  expect(page0.length + page1.length).toBe(122)
  expect(world.files.get(dir + '/s1/0.json')).toContain('q mine')
  expect((world.files.get(dir + '/s1/0.json') ?? '').length).toBeLessThan(3 * 1024 * 1024)
  expect(world.files.get(dir + '/s1/1.json')).toContain('Which plate?')

  // Cleared: the pages are written empty (the file API cannot delete), and nothing comes back.
  await $.command.run({ command: 'interject', args: 'clear' })
  expect(world.files.get(dir + '/s1/0.json')).toBe('[]')
  expect(world.files.get(dir + '/s1/1.json')).toBe('[]')
})

test('a session that goes on under a new id takes over the boxes of the one it continues', async ($, on) => {
  const { world } = engine(on, 'terminal')
  const dir = '/home/t/.claude/interject-boxes'
  // The earlier session's boxes, at reply m1; no index yet, so it is built from the folders.
  const box = { id: 'b1', requestId: 'm1', mode: 'side', status: 'answered', question: 'Which plate?', quote: LINE, answer: 'The round one.' }
  world.files.set(dir + '/old/0.json', JSON.stringify([box]))
  world.files.set(dir + '/other/0.json', JSON.stringify([{ ...box, id: 'b2', requestId: 'zzz', question: 'Elsewhere?' }]))

  await begin($, 'terminal')
  const message = await $.ui.mount(MESSAGE('terminal'))
  await message.redraw()
  expect(await message.find({ type: 'Text', text: /Which plate\?/ })).toBeDefined()
  expect(await message.find({ type: 'Text', text: /Elsewhere\?/ })).toBeUndefined()
  await message.unmount()
  // Saved as this session's own, and the index now names this session for m1.
  expect(world.files.get(dir + '/s1/0.json')).toContain('Which plate?')
  expect(JSON.parse(world.files.get(dir + '/replies.json') ?? '{}')).toEqual({ m1: 's1', zzz: 'other' })
})

test('a resume or /clear inside the process: the boxes of the conversation now shown, each saved to its own', async ($, on) => {
  const { world, clock } = engine(on, 'terminal')
  const dir = '/home/t/.claude/interject-boxes'
  world.selection = { text: LINE, requestId: 'm1' }
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await begin($, 'terminal')
  world.answers.push('The round one.')
  await interject($, 'terminal', 'Which plate?', 'enter')
  const theirs = { id: 'b9', requestId: 'm1', mode: 'side', status: 'answered', question: 'From two?', quote: LINE, answer: 'Yes.' }
  world.files.set(dir + '/s2/0.json', JSON.stringify([theirs]))

  // Resumed into s2 with no session.start. Until the clock notices, s1's box is not drawn in it.
  world.sessionId = 's2'
  const message = await $.ui.mount(MESSAGE('terminal'))
  expect(await message.find({ type: 'Text', text: /Which plate\?/ })).toBeUndefined()
  // Then s2's box is shown, s1's is not: in the row already drawn, with no redraw asked for.
  await clock.advance(400)
  expect(await message.find({ type: 'Text', text: /From two\?/ })).toBeDefined()
  expect(await message.find({ type: 'Text', text: /Which plate\?/ })).toBeUndefined()
  await message.unmount()

  // A box made now is s2's, and s1's saved boxes are left as they were.
  world.answers.push('Under the tank.')
  await interject($, 'terminal', 'Where is it?', 'enter')
  expect(world.files.get(dir + '/s2/0.json')).toContain('Where is it?')
  expect(world.files.get(dir + '/s1/0.json')).toContain('Which plate?')
  expect(world.files.get(dir + '/s1/0.json')).not.toContain('Where is it?')

  // Back to s1: its box again.
  world.sessionId = 's1'
  await clock.advance(400)
  const again = await $.ui.mount(MESSAGE('terminal'))
  await again.redraw()
  expect(await again.find({ type: 'Text', text: /Which plate\?/ })).toBeDefined()
  expect(await again.find({ type: 'Text', text: /From two\?/ })).toBeUndefined()
  await again.unmount()
})

test('a whole paragraph with a link, selected as drawn, finds its line in the source', async ($, on) => {
  const { world } = engine(on, 'desktop')
  const dir = '/home/t/.claude/interject-boxes'
  const PARA = 'In [register.tsx:297](hooks/register.tsx:297), the text sent along holds your question and the answer, as `keptContext` writes it.'
  const TEXT = ['The short version: yes.', '', PARA, '', 'That is all there is to it.'].join('\n')
  const ROW = { plugin: 'interject', surface: 'desktop', component: 'AssistantMessage', requestId: 'p1', props: { text: TEXT, isFirstOfReply: true } } as const
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await begin($, 'desktop')
  const seen = await $.ui.mount(ROW)
  await seen.unmount()

  // As a desktop copies it: the link's words alone, and across rows (no row id).
  world.selection = { text: 'In register.tsx:297, the text sent along holds your question and the answer, as keptContext writes it.\n' }
  await $.command.run({ command: 'interject', args: '' })
  const form = await $.ui.mount(ROW)
  await form.input({ key: 'question', text: 'Which part?', kind: 'submit' })
  await form.unmount()
  await finish($)
  const saved = JSON.parse(world.files.get(dir + '/s1/0.json') ?? '[]') as { quote: string; requestId: string }[]
  expect(saved[0]?.quote).toBe(PARA)
  expect(saved[0]?.requestId).toBe('p1')
})

test('a session holds what the state can (4 MiB): past it the oldest boxes go, with a notice', async ($, on) => {
  const { world } = engine(on, 'terminal')
  world.selection = { text: LINE, requestId: 'm1' }
  on('prompt.submit', (_, e) => ({ text: e.text }))
  const dir = '/home/t/.claude/interject-boxes'
  const many = Array.from({ length: 140 }, (_, i) => ({ id: 'b' + i, requestId: 'm1', mode: 'side', status: 'answered', question: 'q b' + i, quote: LINE, answer: 'z'.repeat(30_000) }))
  world.files.set(dir + '/s1/0.json', JSON.stringify(many.slice(0, 90)))
  world.files.set(dir + '/s1/1.json', JSON.stringify(many.slice(90)))

  await begin($, 'terminal')
  world.answers.push('An answer.')
  await interject($, 'terminal', 'Which plate?', 'enter')
  const saved = [0, 1, 2].flatMap(k => JSON.parse(world.files.get(dir + '/s1/' + k + '.json') ?? '[]') as { id: string; question: string }[])
  expect(saved.length).toBeLessThan(141)
  expect(saved.some(n => n.id === 'b0')).toBe(false)
  expect(saved.some(n => n.id === 'b139')).toBe(true)
  expect(saved.at(-1)?.question).toBe('Which plate?')
  expect(world.toasts.some(t => /oldest/.test(t))).toBe(true)
})

test('a reply with boxes fits its width: every Box says its direction, the boxes may shrink (desktop)', async ($, on) => {
  const { world } = engine(on, 'desktop')
  world.selection = { text: LINE, requestId: 'm1' }
  world.answers.push('A long answer line that a desktop would otherwise draw on one line, wider than the reply. '.repeat(8))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await begin($, 'desktop')
  await interject($, 'desktop', 'Which plate?', 'enter')
  const message = await $.ui.mount(MESSAGE('desktop'))
  const boxes = await message.findAll({ type: 'Box' })
  expect(boxes.length).toBeGreaterThan(2)
  // A Box left on the default row takes its content's width on a desktop, past the reply's edge.
  for (const b of boxes) expect((b.props as { flexDirection?: string }).flexDirection).toBeDefined()
  const bordered = boxes.find(b => (b.props as { borderStyle?: string }).borderStyle === 'round')
  expect((bordered?.props as { minWidth?: number }).minWidth).toBe(0)
  // The root holds the engine's own drawing of the first part: Desktop refuses
  // an engine node under a Box with a size, so the root has none.
  const root = boxes[0]?.props as Record<string, unknown>
  for (const size of ['width', 'height', 'minWidth', 'minHeight']) expect(root[size]).toBeUndefined()
  await message.unmount()
})

test('a box at a table row splits the table into two tables, the header drawn again', async ($, on) => {
  const { world } = engine(on, 'terminal')
  const TABLE = [
    'The parts:',
    '',
    '| Part | Job |',
    '| --- | --- |',
    '| Rig | records video |',
    '| Feeder | turns the plate |',
    '| Server | saves the run |',
    '',
    'That is all.',
  ].join('\n')
  const ROW = { plugin: 'interject', surface: 'terminal', component: 'AssistantMessage', requestId: 't1', props: { text: TABLE, isFirstOfReply: true } } as const
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await begin($, 'terminal')
  const seen = await $.ui.mount(ROW)
  await seen.unmount()

  // At a row in the middle: the rows after the box are a table of their own.
  world.selection = { text: 'Feeder turns the plate', requestId: 't1' }
  await interject($, 'terminal', 'Which plate?', 'enter')
  let row = await $.ui.mount(ROW)
  expect((await row.find({ type: 'Text', text: /engine:/ }))?.text).toContain('| Feeder | turns the plate |')
  expect((await row.find({ type: 'Text', text: /engine:/ }))?.text).not.toContain('Server')
  const after = (await row.findAll({ type: 'Markdown' })).map(m => String(m.props?.text ?? '')).find(t => t.includes('Server'))
  expect(after).toBe('| Part | Job |\n| --- | --- |\n| Server | saves the run |\n\nThat is all.')
  await row.unmount()

  // At the header: the box goes under the rule line, the rows below it.
  world.selection = { text: 'Part Job', requestId: 't1' }
  await interject($, 'terminal', 'Why these?', 'enter')
  row = await $.ui.mount(ROW)
  expect((await row.find({ type: 'Text', text: /engine:/ }))?.text).toContain('| Part | Job |\n| --- | --- |')
  const rows = (await row.findAll({ type: 'Markdown' })).map(m => String(m.props?.text ?? '')).find(t => t.includes('Rig'))
  expect(rows).toBe('| Part | Job |\n| --- | --- |\n| Rig | records video |\n| Feeder | turns the plate |')
  await row.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`cut and continue while Claude writes: stops the turn, sends the interjection, hides the rest (${surface})`, async ($, on) => {
    const { world } = engine(on, surface)
    world.selection = { text: LINE, requestId: 'm1' }
    let aborted = ''
    let submitted = ''
    let hidden = ''
    on('turn.start', (_, e) => ({ turnId: e.turnId }))
    on('turn.abort', (_, e) => {
      aborted = e.turnId
      return { value: undefined }
    })
    on('prompt.submit', (_, e) => {
      submitted = e.text
      return { text: e.text }
    })
    // The note the mod adds for Claude before the message.
    on('session.append', (_, e, next) => {
      if (e.door === 'note') hidden += e.message.content.map(b => (b.type === 'text' ? b.text : '')).join('')
      return next(e)
    })
    await begin($, surface)
    await $.turn.start({ text: 'explain the rig', turnId: 't1' })
    await interject($, surface, 'Why turn it?', 'cut')
    // The turn the cut's message starts: its note goes with that turn's first request.
    expect(hidden).toBe('')
    await $.turn.start({ text: submitted, turnId: 't2' })

    expect(aborted).toBe('t1')
    // The message is one short line; what Claude needs to continue goes before it, unseen.
    expect(submitted).toBe('✂ Cut and continue: Why turn it?')
    expect(hidden).toContain('> Then the **feeder** turns the plate.')
    expect(hidden).toContain('My interjection: Why turn it?')
    expect(hidden).not.toContain('Finally the server saves the run.')

    // The part being written is stored ending at the line.
    const stored = await $.session.append({
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: REPLY }] },
      door: 'response',
      origin: { kind: 'model', model: 'claude-opus-5-5' },
      uuid: 'row-1',
    })
    const storedText = JSON.stringify(stored.message?.content)
    expect(storedText).toContain('turns the plate.')
    expect(storedText).not.toContain('Finally the server saves the run.')

    const message = await $.ui.mount(MESSAGE(surface))
    expect(await message.find({ type: 'Text', text: /The rest of this reply \(1 line\) was cut/ })).toBeDefined()
    expect(await message.find({ type: 'Text', text: 'Why turn it?' })).toBeDefined()
    // The box shows the whole message on a press.
    // In the order Claude read it: the note, then the message.
    const whole = hidden + '\n\n' + submitted
    expect(await message.find({ type: 'Text', text: whole })).toBeUndefined()
    await message.press({ key: await firstKey(message, 'sent-') })
    expect(await message.find({ type: 'Text', text: whole })).toBeDefined()
    await message.unmount()
  })

  test(`the band offers "Interject here" while a line is selected (${surface})`, async ($, on) => {
    const { world, clock } = engine(on, surface)
    await begin($, surface)
    world.selection = { text: LINE, requestId: 'm1' }
    await clock.advance(500)

    const band = await $.ui.mount(BAND(surface))
    expect(await band.find({ key: 'interject-here' })).toBeDefined()
    await band.press({ key: 'interject-here' })
    await band.unmount()

    // The terminal types in the panel; Desktop under the line, in the reply's row.
    const form = await $.ui.mount(surface === 'terminal' ? PANE(surface) : MESSAGE(surface))
    expect(await form.find({ key: 'question' })).toBeDefined()
    expect(await form.find({ type: 'Text', text: /feeder/ })).toBeDefined()
    await form.unmount()
  })

  test(`the band says in its one row what goes with the next message; its text opens at the end of the reply (${surface})`, async ($, on) => {
    const { world, clock } = engine(on, surface)
    world.selection = { text: LINE, requestId: 'm1' }
    world.answers.push('Use the round plate.\n\nIt sits under the tank.', 'The tank.')
    let sentContext: readonly string[] = []
    on('prompt.submit', (_, e) => {
      sentContext = attachedOf(e.text)
      return { text: e.text }
    })
    await begin($, surface)
    await interject($, surface, 'Which plate?', 'enter')
    const drawn = await $.ui.mount(MESSAGE(surface))
    await drawn.unmount()
    world.selection = { text: 'It sits under the tank.', requestId: 'm1' }
    await interject($, surface, 'Which tank?', 'enter')
    world.selection = undefined

    // Nothing kept: the band draws nothing of the mod's.
    const empty = await $.ui.mount(BAND(surface))
    expect(await empty.find({ key: 'interject-preview' })).toBeUndefined()
    await empty.unmount()

    // Keep the inner box (the first keep drawn): it and the box it sits in go.
    const message = await $.ui.mount(MESSAGE(surface))
    await message.press({ key: await firstKey(message, 'keep-') })
    await message.unmount()

    // The band: one row, with the count as a button.
    const band = await $.ui.mount(BAND(surface))
    const count = await band.find({ key: 'interject-preview' })
    expect(count?.props?.label).toBe('📎 2 boxes go with your next message · show')
    expect(await band.find({ key: 'interject-here' })).toBeUndefined()
    await band.press({ key: 'interject-preview' })
    await band.unmount()

    // Pressed, the exact text opens at the end of the latest reply.
    const reply = await $.ui.mount(MESSAGE(surface))
    const shown = String((await reply.find({ type: 'Text', text: /The exchanges they kept/ }))?.text ?? '')
    expect(shown).toContain('The user asked: Which plate?')
    expect(shown).toContain('The user asked: Which tank?')
    await reply.unmount()

    // While a line is selected, ✎ and the count share the one row.
    world.selection = { text: LINE, requestId: 'm1' }
    await clock.advance(500)
    const selecting = await $.ui.mount(BAND(surface))
    const row = (await selecting.findAll({ type: 'Box' })).find(b => b.props?.flexDirection === 'row')
    const keysInRow = (await selecting.findAll({ type: 'Button' })).map(b => b.key)
    expect(row).toBeDefined()
    expect(keysInRow).toEqual(['interject-here', 'interject-preview'])
    expect((await selecting.find({ key: 'interject-preview' }))?.props?.label).toBe('📎 2 boxes go with your next message · hide')
    await selecting.unmount()
    world.selection = undefined
    await clock.advance(500)

    // What was shown is what is sent; after that the band and the reply drop it.
    await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })
    expect(sentContext.join('\n\n')).toBe(shown)
    const after = await $.ui.mount(BAND(surface))
    expect(await after.find({ key: 'interject-preview' })).toBeUndefined()
    await after.unmount()
    const closed = await $.ui.mount(MESSAGE(surface))
    expect(await closed.find({ type: 'Text', text: /The exchanges they kept/ })).toBeUndefined()
    await closed.unmount()
  })
}

for (const surface of ['desktop', 'vscode'] as const) {
  test(`the form opens under the selected line, not in the panel (${surface})`, async ($, on) => {
    const { world } = engine(on, surface)
    world.selection = { text: LINE, requestId: 'm1' }
    await begin($, surface)
    await $.command.run({ command: 'interject', args: '' })
    expect(world.opened).toEqual([])

    const message = await $.ui.mount(MESSAGE(surface))
    // The reply up to the line, then the form, then the rest of the reply.
    const before = (await message.find({ type: 'Text', text: /engine:/ }))?.text ?? ''
    expect(before).toContain('feeder')
    expect(before).not.toContain('Finally')
    expect(await message.find({ type: 'Text', text: /Interject at this line/ })).toBeDefined()
    expect(await message.find({ key: 'question' })).toBeDefined()
    expect(await message.find({ type: 'Markdown', text: /Finally the server/ })).toBeDefined()

    await message.press({ key: 'cancel' })
    expect(await message.find({ key: 'question' })).toBeUndefined()
    expect(world.closed).toEqual([])
    await message.unmount()
  })

  test(`typing in the form redraws nothing, and what was typed is what is sent (${surface})`, async ($, on) => {
    const { world } = engine(on, surface)
    world.selection = { text: LINE, requestId: 'm1' }
    await begin($, surface)
    await $.command.run({ command: 'interject', args: '' })
    const message = await $.ui.mount(MESSAGE(surface))
    const before = world.draws
    for (const text of ['W', 'Wh', 'Which', 'Which plate?']) {
      await message.input({ key: 'question', text, kind: 'change' })
    }
    expect(world.draws).toBe(before)
    await message.press({ key: 'queue' })
    expect(await message.find({ type: 'Text', text: 'Which plate?' })).toBeDefined()
    await message.unmount()
  })

  test(`a line selected as a desktop draws it, with typographic punctuation, anchors there (${surface})`, async ($, on) => {
    const { world } = engine(on, surface)
    const text = [
      "I can't see the window -- so check it yourself...",
      '',
      'The "box" sits under the line.',
      '',
      'Then the rest of the reply.',
    ].join('\n')
    const row = { ...MESSAGE(surface), props: { text, isFirstOfReply: true } }
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await (await $.ui.mount(row)).unmount()

    // What the person selects is drawn text: curly quotes, an en dash, an ellipsis.
    world.selection = { text: 'can’t see the window – so check it yourself…', requestId: 'm1' }
    await $.command.run({ command: 'interject', args: '' })
    const message = await $.ui.mount(row)
    const before = (await message.find({ type: 'Text', text: /engine:/ }))?.text ?? ''
    expect(before).toContain("can't see the window")
    expect(before).not.toContain('box')
    expect(await message.find({ key: 'question' })).toBeDefined()
    expect(await message.find({ type: 'Markdown', text: /The "box" sits/ })).toBeDefined()
    await message.unmount()
  })

  test(`with nothing selected, the list of lines is at the end of the reply, not in a panel (${surface})`, async ($, on) => {
    const { world } = engine(on, surface)
    await begin($, surface)
    await $.command.run({ command: 'interject', args: '' })
    expect(world.opened).toEqual([])

    const message = await $.ui.mount(MESSAGE(surface))
    // The reply is drawn whole, then the list.
    expect((await message.find({ type: 'Text', text: /engine:/ }))?.text).toContain('Finally')
    expect(await message.find({ type: 'Text', text: /Which line\? Click one/ })).toBeDefined()
    await message.press({ key: 'line-1' })
    expect(world.closed).toEqual([])
    expect(await message.find({ key: 'line-1' })).toBeUndefined()
    const before = (await message.find({ type: 'Text', text: /engine:/ }))?.text ?? ''
    expect(before).toContain('feeder')
    expect(before).not.toContain('Finally')
    expect(await message.find({ key: 'question' })).toBeDefined()
    await message.input({ key: 'question', text: 'Which plate?', kind: 'change' })
    await message.press({ key: 'queue' })
    expect(await message.find({ key: 'question' })).toBeUndefined()
    expect(await message.find({ type: 'Text', text: /Will be attached to your next message/ })).toBeDefined()
    await message.unmount()
  })
}

for (const surface of ['desktop', 'vscode'] as const) {
  test(`✎ works when the click cleared the selection: the band's selection stands in (${surface})`, async ($, on) => {
    const { world, clock } = engine(on, surface)
    await begin($, surface)
    world.selection = { text: LINE, requestId: 'm1' }
    await clock.advance(500)
    const band = await $.ui.mount(BAND(surface))
    world.selection = undefined
    await band.press({ key: 'interject-here' })
    await band.unmount()
    expect(world.opened).toEqual([])

    const message = await $.ui.mount(MESSAGE(surface))
    expect(await message.find({ type: 'Text', text: /Interject at this line/ })).toBeDefined()
    expect(await message.find({ key: 'line-1' })).toBeUndefined()
    await message.unmount()
  })
}

test('✎ still has the selection when a check lands between the press that cleared it and the click', async ($, on) => {
  const { world, clock } = engine(on, 'terminal')
  await begin($, 'terminal')
  world.selection = { text: LINE, requestId: 'm1' }
  await clock.advance(500)
  const band = await $.ui.mount(BAND('terminal'))
  // The mouse press clears the selection; a check runs before the button does.
  world.selection = undefined
  await clock.advance(400)
  await band.press({ key: 'interject-here' })
  await band.unmount()
  // The form for that line opens, not the list of lines.
  const pane = await $.ui.mount(PANE('terminal'))
  expect(await pane.find({ key: 'question' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /feeder/ })).toBeDefined()
  await pane.unmount()

  // A selection cleared for good is let go after about a second.
  await clock.advance(1600)
  const later = await $.ui.mount(BAND('terminal'))
  expect(await later.find({ key: 'interject-here' })).toBeUndefined()
  await later.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`quick answer: no agent, one request without tools, then ask again with tools (${surface})`, async ($, on) => {
    const { world } = engine(on, surface)
    world.selection = { text: LINE, requestId: 'm1' }
    world.answers.push('Probably the round feedplate.', 'The round feedplate: see rig.py.')
    await begin($, surface)
    await interject($, surface, 'Which plate?', 'quick')
    expect(world.agents).toEqual([])
    expect(world.forkPrompts[0]).toContain('You have no tools here')

    const message = await $.ui.mount(MESSAGE(surface))
    expect(await message.find({ type: 'Markdown', text: /Probably the round feedplate/ })).toBeDefined()
    expect(await message.find({ type: 'Text', text: /Quick answer, without tools/ })).toBeDefined()

    await message.press({ key: await firstKey(message, 'tools-') })
    expect(world.agents.map(a => a.type)).toEqual(['fork'])
    expect(world.forkPrompts[1]).toContain('Use tools as the question needs')
    await message.redraw()
    expect(await message.find({ type: 'Text', text: /Working on it on the side/ })).toBeDefined()
    await finish($)
    await message.redraw()
    expect(await message.find({ type: 'Markdown', text: /see rig\.py/ })).toBeDefined()
    expect(await message.find({ type: 'Text', text: /without tools/ })).toBeUndefined()
    expect(await firstKey(message, 'tools-')).toBe('')
    await message.unmount()
  })
}

/** The lines a headless Claude Code fork writes with --output-format stream-json, for `world.childLines`. */
const CHILD = [
  JSON.stringify({ type: 'system', subtype: 'init' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'grep -n plate rig.py' } }] } }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'The round feedplate: see rig.py.' }),
]

test('auto mode in Desktop refuses the agent: the side chat runs as a headless fork, with tools', async ($, on) => {
  const { world } = engine(on, 'desktop')
  world.selection = { text: LINE, requestId: 'm1' }
  world.denySpawns = 1
  world.childLines = CHILD
  await begin($, 'desktop')
  await interject($, 'desktop', 'Which plate?', 'enter')

  const argv = world.children[0] ?? []
  expect(argv.slice(0, 2)).toEqual(['claude', '-p'])
  expect(argv[2]).toContain('Which plate?')
  expect(argv).toContain('--fork-session')
  expect(argv).toContain('--no-session-persistence')
  expect(argv[argv.indexOf('--resume') + 1]).toBe('s1')
  expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('auto')
  const message = await $.ui.mount(MESSAGE('desktop'))
  expect(await message.find({ type: 'Markdown', text: /round feedplate: see rig\.py/ })).toBeDefined()
  expect(await message.find({ type: 'Text', text: /Used tools: Bash/ })).toBeDefined()
  expect(await message.find({ type: 'Text', text: /without tools/ })).toBeUndefined()
  await message.unmount()
})

test('a headless fork that cannot start falls back to an answer without tools, and says so', async ($, on) => {
  const { world } = engine(on, 'desktop')
  world.selection = { text: LINE, requestId: 'm1' }
  world.denySpawns = 1
  world.answers.push('The round feedplate.')
  await begin($, 'desktop')
  await interject($, 'desktop', 'Which plate?', 'enter')
  expect(world.forkPrompts.at(-1)).toContain('You have no tools here')
  const message = await $.ui.mount(MESSAGE('desktop'))
  expect(await message.find({ type: 'Markdown', text: /round feedplate/ })).toBeDefined()
  expect(await message.find({ type: 'Text', text: /Answered without tools: auto mode did not let a side agent start/ })).toBeDefined()
  await message.unmount()
})

test('a cut that could not be sent waits for Enter, and goes with the next prompt', async ($, on) => {
  const { world } = engine(on)
  world.selection = { text: LINE, requestId: 'm1' }
  let filled = ''
  let sentContext: readonly string[] = []
  on('prompt.fill', (_, e) => {
    filled = e.text
    return { isFilled: true }
  })
  on('prompt.submit', (_, e) => {
    if (e.text.startsWith('✂ Cut and continue')) return { drop: 'the session was stopped and nobody has sent input since' }
    sentContext = attachedOf(e.text)
    return { text: e.text }
  })
  await begin($, 'terminal')
  await interject($, 'terminal', 'Why turn it?', 'cut')
  expect(filled).toBe('Why turn it?')

  await $.prompt.submit({ text: 'Why turn it?', wait: false, origin: { kind: 'composer' } })
  expect(sentContext[0]).toContain('withdrawn')
  expect(sentContext[0]).toContain('> Then the **feeder** turns the plate.')
})

test('with nothing selected, the panel lists the lines to pick from', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'interject', args: '' })
  const pane = await $.ui.mount(PANE('terminal'))
  expect(await pane.find({ key: 'line-2' })).toBeDefined()
  expect(await pane.find({ key: 'earlier' })).toBeDefined()
  await pane.press({ key: 'line-1' })
  expect(await pane.find({ type: 'Text', text: /feeder/ })).toBeDefined()
  expect(await pane.find({ key: 'question' })).toBeDefined()
  await pane.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a side chat is a fork that can use tools, its steps shown while it works (${surface})`, async ($, on) => {
    const { world } = engine(on, surface)
    world.selection = { text: LINE, requestId: 'm1' }
    world.answers.push('The plate turns every 30 s: see `rig.py`.')
    await begin($, surface)
    await $.command.run({ command: 'interject', args: '' })
    const form = await $.ui.mount(surface === 'terminal' ? PANE(surface) : MESSAGE(surface))
    await form.input({ key: 'question', text: 'How often?', kind: 'submit' })
    await form.unmount()

    expect(world.agents.map(a => a.type)).toEqual(['fork'])
    expect(world.forkPrompts[0]).toContain('Use tools as the question needs')
    expect(world.forkPrompts[0]).toContain('How often?')

    const message = await $.ui.mount(MESSAGE(surface))
    expect(await message.find({ type: 'Text', text: /Working on it on the side/ })).toBeDefined()
    await $.tool.call({ tool: 'Bash', command: 'grep -n interval rig.py', agentId: 'agent-1' })
    await message.redraw()
    expect(await message.find({ type: 'Text', text: /· Bash grep -n interval rig\.py/ })).toBeDefined()

    await finish($)
    await message.redraw()
    expect(await message.find({ type: 'Markdown', text: /every 30 s/ })).toBeDefined()
    expect(await message.find({ type: 'Text', text: /Used tools: Bash/ })).toBeDefined()
    await message.unmount()
  })
}

test('a side chat that finishes stays out of the conversation: its notice is dropped', async ($, on) => {
  const { world } = engine(on, 'desktop')
  world.selection = { text: LINE, requestId: 'm1' }
  on('prompt.submit', (_, e) => {
    world.submitted.push(e.text)
    return { text: e.text }
  })
  await begin($, 'desktop')
  await interject($, 'desktop', 'Which plate?', 'enter')

  const notice = await $.prompt.submit({
    text: '<task-notification><task-id>agent-1</task-id><status>completed</status></task-notification>',
    wait: false,
    origin: { kind: 'task-notification' },
  })
  expect(notice.drop).toBeDefined()
  const other = await $.prompt.submit({
    text: '<task-notification><task-id>agent-99</task-id></task-notification>',
    wait: false,
    origin: { kind: 'task-notification' },
  })
  expect(other.drop).toBeUndefined()
  expect(world.submitted).toEqual(['<task-notification><task-id>agent-99</task-id></task-notification>'])
})

test('fork to session: a New task card that opens the side chat under this session (desktop)', async ($, on) => {
  const { world } = engine(on, 'desktop')
  world.selection = { text: LINE, requestId: 'm1' }
  world.answers.push('The round feedplate.')
  world.startOnlyOnWords = true
  await begin($, 'desktop')
  await interject($, 'desktop', 'Which plate?', 'enter')

  const message = await $.ui.mount(MESSAGE('desktop'))
  await message.press({ key: await firstKey(message, 'fork-') })
  const calls = world.tools.filter(t => t.tool === 'mcp__ccd_session__start_session')
  expect(calls.map(c => c.input.initiation)).toEqual(['own_initiative'])
  expect(calls[0]?.input.context).toBe('fork')
  expect(calls[0]?.input.title).toBe('Side chat: Which plate?')
  expect(String(calls[0]?.input.prompt)).toContain('Which plate?')
  expect(String(calls[0]?.input.prompt)).toContain('The round feedplate.')
  await message.redraw()
  expect(await message.find({ type: 'Text', text: /Press Start on the New task card/ })).toBeDefined()
  expect(await firstKey(message, 'fork-')).toBe('')
  await message.unmount()
})
test('fork to session where auto mode refuses the card: a saved CLI fork, opened in the app by its Resume link', async ($, on) => {
  const { world } = engine(on, 'desktop')
  world.selection = { text: LINE, requestId: 'm1' }
  world.sessionToolDenied = true
  world.answers.push('The round feedplate.')
  const runs: string[][] = []
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    const stdout = e.argv[0] === 'claude' ? JSON.stringify({ type: 'result', session_id: '0f0e0d0c-1111-2222-3333-444455556666' }) : ''
    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })
  await begin($, 'desktop')
  await interject($, 'desktop', 'Which plate?', 'enter')

  const message = await $.ui.mount(MESSAGE('desktop'))
  await message.press({ key: await firstKey(message, 'fork-') })
  const fork = runs.find(r => r[0] === 'claude') ?? []
  expect(fork[2]).toContain('The round feedplate.')
  expect(fork).toContain('--fork-session')
  expect(fork[fork.indexOf('--resume') + 1]).toBe('s1')
  expect(fork[fork.indexOf('--name') + 1]).toBe('Side chat: Which plate?')
  expect(runs.find(r => r[0] === 'open')).toEqual(['open', 'claude://resume?session=0f0e0d0c-1111-2222-3333-444455556666'])
  await message.redraw()
  expect(await message.find({ type: 'Text', text: /it opened in Claude/ })).toBeDefined()
  await message.unmount()
})

test('Desktop: a message sent from its own box takes what was added to the next message', async ($, on) => {
  const { world } = engine(on, 'desktop')
  world.selection = { text: LINE, requestId: 'm1' }
  let sentContext: readonly string[] = []
  on('prompt.submit', (_, e) => {
    sentContext = attachedOf(e.text)
    return { text: e.text, context: e.context }
  })
  await begin($, 'desktop')
  await interject($, 'desktop', 'Which plate?', 'queue')
  await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'sdk' } })
  expect(sentContext.length).toBe(1)
  expect(sentContext[0]).toContain('Which plate?')
})

test('fork to session is offered on Desktop only', async ($, on) => {
  const { world } = engine(on, 'terminal')
  world.selection = { text: LINE, requestId: 'm1' }
  await begin($, 'terminal')
  await interject($, 'terminal', 'Which plate?', 'enter')
  const message = await $.ui.mount(MESSAGE('terminal'))
  expect(await firstKey(message, 'follow-')).not.toBe('')
  expect(await firstKey(message, 'fork-')).toBe('')
  await message.unmount()
})

test('from the keyboard: /interject ask asks at the last line, /interject fork forks the answer', async ($, on) => {
  const { world } = engine(on, 'desktop')
  world.answers.push('The round feedplate.')
  await begin($, 'desktop')
  const asked = await $.command.run({ command: 'interject', args: 'ask Which plate?' } as never)
  expect(asked.text).toContain('Asked on the side')
  await finish($)
  const message = await $.ui.mount(MESSAGE('desktop'))
  expect(await message.find({ type: 'Text', text: /Which plate\?/ })).toBeDefined()
  await $.command.run({ command: 'interject', args: 'fork' } as never)
  const card = world.tools.find(t => t.tool === 'mcp__ccd_session__start_session')
  expect(card?.input.initiation).toBe('own_initiative')
  expect(String(card?.input.prompt)).toContain('The round feedplate.')
  await message.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a message sent with boxes: drawn as typed, with a small line, and all of it on a press (${surface})`, async ($, on) => {
    const { world } = engine(on, surface)
    world.selection = { text: LINE, requestId: 'm1' }
    let sentText = ''
    on('prompt.submit', (_, e) => {
      sentText = e.text
      return { text: e.text }
    })
    await begin($, surface)
    await interject($, surface, 'Which plate?', 'queue')
    await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })

    // Desktop says every row is drawn in full; the terminal says so only in ctrl+o.
    const row = await $.ui.mount(USER(surface, sentText, { kind: 'composer' }, surface === 'desktop'))
    expect((await row.find({ type: 'Text', text: /engine:/ }))?.text).not.toContain('attached')
    expect(await row.find({ type: 'Text', text: '📎 Sent with 1 box' })).toBeDefined()
    expect(await row.find({ type: 'Text', text: /Which plate\?/ })).toBeUndefined()
    await row.press({ key: 'full-u1' })
    expect(await row.find({ type: 'Text', text: /Which plate\?/ })).toBeDefined()
    expect((await row.find({ key: 'full-u1' }))?.props?.label).toBe('▴ hide')
    await row.press({ key: 'full-u1' })
    expect(await row.find({ type: 'Text', text: /Which plate\?/ })).toBeUndefined()
    await row.unmount()
  })
}

test('ctrl+o in the terminal shows a message with boxes in full, as stored', async ($, on) => {
  engine(on, 'terminal')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const text = 'go on\n\n[interject: 1 box attached to this message]\nWhile reading your earlier reply, the user interjected.'
  const row = await $.ui.mount(USER('terminal', text, { kind: 'composer' }, true))
  expect((await row.find({ type: 'Text', text: /engine:/ }))?.text).toContain('the user interjected')
  expect(await row.find({ key: 'full-u1' })).toBeUndefined()
  await row.unmount()
})

/** A new reply row, as Claude's answer to the person's last message draws it. */
const ANSWER = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'interject',
    surface,
    component: 'AssistantMessage',
    requestId: 'm2',
    props: { text: 'Here is the answer.', isFirstOfReply: true },
  }) as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a message sent with boxes: what went with it is saved once, and the answer's top line shows it (${surface})`, async ($, on) => {
    const { world, clock } = engine(on, surface)
    world.selection = { text: LINE, requestId: 'm1' }
    world.answers.push('Use the round plate.\n\nIt sits under the tank.', 'The tank.')
    let sent: readonly string[] = []
    on('turn.start', (_, e) => ({ turnId: e.turnId }))
    on('prompt.submit', (_, e) => {
      sent = attachedOf(e.text)
      return { text: e.text }
    })
    await begin($, surface)
    await interject($, surface, 'Which plate?', 'enter')
    const drawn = await $.ui.mount(MESSAGE(surface))
    await drawn.unmount()
    world.selection = { text: 'It sits under the tank.', requestId: 'm1' }
    await interject($, surface, 'Which tank?', 'enter')
    // Keep both boxes: one message takes both.
    const message = await $.ui.mount(MESSAGE(surface))
    for (const key of (await message.findAll({ type: 'Button' })).map(b => b.key ?? '').filter(k => k.startsWith('keep-'))) {
      if (await message.find({ key })) await message.press({ key })
    }
    await message.unmount()

    await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'go on', turnId: 't2' })
    const whole = sent[0] ?? ''
    expect(whole).toContain('The user asked: Which tank?')

    // Saved once, in a file of its own; the boxes hold only its id.
    const files = [...world.files.entries()]
    expect(files.filter(([path, text]) => path.includes('/sent/') && text === whole).length).toBe(1)
    const pages = files.filter(([path]) => /\/s1\/\d+\.json$/.test(path)).map(([, text]) => text).join('')
    expect(pages).not.toContain('The exchanges they kept')
    const ids = new Set((JSON.parse(world.files.get('/home/t/.claude/interject-boxes/s1/0.json') ?? '[]') as { sentId?: string }[]).map(n => n.sentId))
    ids.delete(undefined)
    expect(ids.size).toBe(1)

    // The first new row of the answer: a 📎 line in Desktop; the terminal shows it on the message row.
    const answer = await $.ui.mount(ANSWER(surface))
    if (surface === 'terminal') {
      expect(await answer.find({ type: 'Text', text: /^📎/ })).toBeUndefined()
      await answer.unmount()
      return
    }
    expect(await answer.find({ type: 'Text', text: '📎 Your message went with 2 boxes' })).toBeDefined()
    expect((await answer.find({ type: 'Text', text: /engine:/ }))?.text).toContain('Here is the answer.')
    const key = (await answer.findAll({ type: 'Button' })).map(b => b.key ?? '').find(k => k.startsWith('send-')) ?? ''
    await answer.press({ key })
    expect(await answer.find({ type: 'Text', text: whole })).toBeDefined()
    await answer.unmount()

    // The clock saves which row took it: drawn again later, it is still there; the older reply has none.
    await clock.advance(500)
    expect(world.files.get('/home/t/.claude/interject-boxes/s1/sends.json')).toContain('"row":"m2"')
    const again = await $.ui.mount(ANSWER(surface))
    expect(await again.find({ type: 'Text', text: '📎 Your message went with 2 boxes' })).toBeDefined()
    await again.unmount()
    const older = await $.ui.mount(MESSAGE(surface))
    expect(await older.find({ type: 'Text', text: /^📎 Your message went/ })).toBeUndefined()
    await older.unmount()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a note that follows up on a kept box: the kept exchange goes once, and the note names it (${surface})`, async ($, on) => {
    const { world } = engine(on, surface)
    world.selection = { text: LINE, requestId: 'm1' }
    world.answers.push('A debugging log.')
    let sent = ''
    on('prompt.submit', (_, e) => {
      sent = attachedOf(e.text).join('')
      return { text: e.text }
    })
    await begin($, surface)
    await interject($, surface, "What's the trace?", 'enter')
    const message = await $.ui.mount(MESSAGE(surface))
    await message.press({ key: await firstKey(message, 'keep-') })
    await message.press({ key: await firstKey(message, 'follow-') })
    await message.unmount()
    const form = await $.ui.mount(surface === 'terminal' ? PANE(surface) : MESSAGE(surface))
    await form.input({ key: 'question', text: 'Good idea, do it.', kind: 'change' })
    await form.press({ key: 'queue' })
    await form.unmount()

    await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })
    expect(sent.split("The user asked: What's the trace?").length - 1).toBe(1)
    expect(sent.split('A debugging log.').length - 1).toBe(1)
    expect(sent).toContain('It builds on an exchange given above: "What\'s the trace?".')
    expect(sent).toContain('Their note or question: Good idea, do it.')
  })

  test(`boxes at one line are drawn in thread order: a follow-up right after the box it follows (${surface})`, async ($, on) => {
    const { world } = engine(on, surface)
    world.selection = { text: LINE, requestId: 'm1' }
    world.answers.push('Answer A.', 'Answer B.', 'Answer C.')
    await begin($, surface)
    await interject($, surface, 'Question A?', 'enter')
    await interject($, surface, 'Question B?', 'enter')
    const message = await $.ui.mount(MESSAGE(surface))
    await message.press({ key: await firstKey(message, 'follow-') })
    await message.unmount()
    const form = await $.ui.mount(surface === 'terminal' ? PANE(surface) : MESSAGE(surface))
    await form.input({ key: 'question', text: 'Question C?', kind: 'submit' })
    await form.unmount()
    await finish($)

    const drawn = await $.ui.mount(MESSAGE(surface))
    const order = (await drawn.findAll({ type: 'Text' })).map(t => String(t.text ?? '')).filter(t => /^Question [ABC]\?$/.test(t))
    expect(order).toEqual(['Question A?', 'Question C?', 'Question B?'])
    expect(await drawn.find({ type: 'Text', text: '↳ follows up: Question A?' })).toBeDefined()
    await drawn.unmount()
  })
}

for (const surface of ['desktop', 'vscode'] as const) {
  test(`a second follow-up on a box: its form and then its box sit right under that box, before the first follow-up (${surface})`, async ($, on) => {
    const { world } = engine(on, surface)
    world.selection = { text: LINE, requestId: 'm1' }
    world.answers.push('Answer A.', 'Answer B.', 'Answer C.')
    await begin($, surface)
    await interject($, surface, 'Question A?', 'enter')
    const followA = async () => {
      const message = await $.ui.mount(MESSAGE(surface))
      await message.press({ key: await firstKey(message, 'follow-') })
      await message.unmount()
    }
    await followA()
    const first = await $.ui.mount(MESSAGE(surface))
    await first.input({ key: 'question', text: 'Question B?', kind: 'submit' })
    await first.unmount()
    await finish($)

    // Follow up on A again: the form opens between A and B.
    await followA()
    const form = await $.ui.mount(MESSAGE(surface))
    const texts = (await form.findAll({ type: 'Text' })).map(t => String(t.text ?? ''))
    const at = (t: string) => texts.indexOf(t)
    expect(at('Question A?')).toBeLessThan(at('✎ Interject at this line'))
    expect(at('✎ Interject at this line')).toBeLessThan(at('Question B?'))
    await form.input({ key: 'question', text: 'Question C?', kind: 'submit' })
    await form.unmount()
    await finish($)

    const drawn = await $.ui.mount(MESSAGE(surface))
    const order = (await drawn.findAll({ type: 'Text' })).map(t => String(t.text ?? '')).filter(t => /^Question [ABC]\?$/.test(t))
    expect(order).toEqual(['Question A?', 'Question C?', 'Question B?'])
    await drawn.unmount()
    // The side chat is told it is a follow-up, not a line of an answer.
    expect(world.forkPrompts.at(-1)).toContain('Now they follow up on the last of those questions, about the same line:')
    expect(world.forkPrompts.at(-1)).not.toContain('last side answer')
  })
}

test('what is sent names the box each follow-up builds on, and quotes the line once', async ($, on) => {
  const { world } = engine(on, 'desktop')
  world.selection = { text: LINE, requestId: 'm1' }
  world.answers.push('Answer A.', 'Answer B.', 'Answer C.')
  let sent = ''
  on('prompt.submit', (_, e) => {
    sent = attachedOf(e.text).join('')
    return { text: e.text }
  })
  await begin($, 'desktop')
  await interject($, 'desktop', 'Question A?', 'enter')
  // B follows up on A, C follows up on B.
  for (const [question, follows] of [['Question B?', 'Question A?'], ['Question C?', 'Question B?']] as const) {
    const message = await $.ui.mount(MESSAGE('desktop'))
    const boxes = (await message.findAll({ type: 'Button' })).map(b => b.key ?? '').filter(k => k.startsWith('follow-'))
    const texts = (await message.findAll({ type: 'Text' })).map(t => String(t.text ?? ''))
    const order = texts.filter(t => /^Question [ABC]\?$/.test(t))
    await message.press({ key: boxes[order.indexOf(follows)] ?? '' })
    await message.unmount()
    const form = await $.ui.mount(MESSAGE('desktop'))
    await form.input({ key: 'question', text: question, kind: 'submit' })
    await form.unmount()
    await finish($)
  }
  const message = await $.ui.mount(MESSAGE('desktop'))
  const keeps = (await message.findAll({ type: 'Button' })).map(b => b.key ?? '').filter(k => k.startsWith('keep-'))
  const order = (await message.findAll({ type: 'Text' })).map(t => String(t.text ?? '')).filter(t => /^Question [ABC]\?$/.test(t))
  await message.press({ key: keeps[order.indexOf('Question C?')] ?? '' })
  await message.unmount()

  await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })
  expect(sent.split('At this line:').length - 1).toBe(1)
  expect(sent).toContain('Following up on "Question A?":\nThe user asked: Question B?')
  expect(sent).toContain('Following up on "Question B?":\nThe user asked: Question C?')
})

const ROW = (surface: 'terminal' | 'desktop', id: string, text: string) =>
  ({ plugin: 'interject', surface, component: 'AssistantMessage', requestId: id, props: { text, isFirstOfReply: true } }) as const

test('a message typed while Claude works: no row of the running reply takes its 📎 line', async ($, on) => {
  const { world } = engine(on, 'desktop')
  world.selection = { text: LINE, requestId: 'm1' }
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await begin($, 'desktop')
  await interject($, 'desktop', 'Which plate?', 'queue')
  // Claude is working on an earlier prompt (t1); the person types with the box queued.
  await $.turn.start({ text: 'earlier prompt', turnId: 't1' })
  await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' }, turnId: 't1' } as never)
  // t1 draws another block of its own reply (after a tool call, say).
  const old = await $.ui.mount(ROW('desktop', 'm1b', 'Still answering the earlier prompt.'))
  const onOld = await old.find({ type: 'Text', text: /^📎 Your message went/ })
  await old.unmount()
  expect(onOld).toBeUndefined()
})

test('a send whose turn draws no row: a later answer does not take its 📎 line', async ($, on) => {
  const { world } = engine(on, 'desktop')
  world.selection = { text: LINE, requestId: 'm1' }
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await begin($, 'desktop')
  await interject($, 'desktop', 'Which plate?', 'queue')
  await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'go on', turnId: 't2' })
  // The person presses Esc before any text: the turn ends with no reply row.
  await $.turn.complete({ turnId: 't2', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' } as never)
  // A later plain message, no boxes.
  await $.prompt.submit({ text: 'unrelated', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'unrelated', turnId: 't3' })
  const later = await $.ui.mount(ROW('desktop', 'm3', 'Answer to unrelated.'))
  const wrong = await later.find({ type: 'Text', text: /^📎 Your message went/ })
  await later.unmount()
  expect(wrong).toBeUndefined()
})

test('a cut that is not sent leaves no note for Claude, and once dismissed adds nothing', async ($, on) => {
  const { world } = engine(on)
  world.selection = { text: LINE, requestId: 'm1' }
  const notes: string[] = []
  on('prompt.fill', () => ({ isFilled: true }))
  on('session.append', (_, e, next) => {
    if (e.door === 'note') notes.push(e.message.content.map(b => (b.type === 'text' ? b.text : '')).join(''))
    return next(e)
  })
  let sent = ''
  on('prompt.submit', (_, e) => {
    if (e.text.startsWith('✂ Cut and continue')) return { drop: 'the session was stopped' }
    sent = e.text
    return { text: e.text }
  })
  await begin($, 'terminal')
  await interject($, 'terminal', 'Why turn it?', 'cut')
  const message = await $.ui.mount(MESSAGE('terminal'))
  await message.press({ key: await firstKey(message, 'dismiss-') })
  await message.unmount()
  await $.prompt.submit({ text: 'something else', wait: false, origin: { kind: 'composer' } })
  // The dismissed cut adds nothing to the message ...
  expect(sent).toBe('something else')
  // ... but its note was appended and waits for the next request.
  expect(notes.length).toBe(0)
})

test('the preview closes on a switch to another conversation', async ($, on) => {
  const { world, clock } = engine(on, 'desktop')
  world.selection = { text: LINE, requestId: 'm1' }
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await begin($, 'desktop')
  await interject($, 'desktop', 'Which plate?', 'queue')
  const band = await $.ui.mount(BAND('desktop'))
  await band.press({ key: 'interject-preview' })
  await band.unmount()
  const dir = '/home/t/.claude/interject-boxes'
  world.files.set(dir + '/s2/0.json', JSON.stringify([{ id: 'q9', requestId: 'm1', mode: 'queue', status: 'queued', question: 'Other?', quote: LINE }]))
  world.sessionId = 's2'
  world.selection = undefined
  await clock.advance(2000)
  const band2 = await $.ui.mount(BAND('desktop'))
  const label = (await band2.find({ key: 'interject-preview' }))?.props?.label
  await band2.unmount()
  expect(label).toBe('📎 1 box goes with your next message · show')
})

test('a cut message from before is still drawn as one line', async ($, on) => {
  engine(on, 'terminal')
  await begin($, 'terminal')
  const old = '[interject: cut and continue]\nI stopped reading your reply at this line:\n> x\n<kept_reply>\nlots\n</kept_reply>\n\nMy interjection: Why?'
  const row = await $.ui.mount(USER('terminal', old, { kind: 'plugin', name: 'interject' }, false))
  const t = (await row.find({ type: 'Text', text: /engine:/ }))?.text ?? ''
  await row.unmount()
  expect(String(t)).not.toContain('kept_reply')
})

test('a pasted marker: the row splits at the mod\'s own, the last one', async ($, on) => {
  const { world } = engine(on, 'desktop')
  world.selection = { text: LINE, requestId: 'm1' }
  let sentText = ''
  on('prompt.submit', (_, e) => {
    sentText = e.text
    return { text: e.text }
  })
  await begin($, 'desktop')
  await interject($, 'desktop', 'Which plate?', 'queue')
  const typed = 'Earlier I sent:\n\n[interject: 3 boxes attached to this message]\nold stuff\n\nwhat do you think?'
  await $.prompt.submit({ text: typed, wait: false, origin: { kind: 'composer' } })
  const row = await $.ui.mount(USER('desktop', sentText, { kind: 'composer' }, true))
  const own = String((await row.find({ type: 'Text', text: /engine:/ }))?.text ?? '')
  const count = await row.find({ type: 'Text', text: '📎 Sent with 1 box' })
  await row.unmount()
  expect(own).toContain('what do you think?')
  expect(count).toBeDefined()
})

test('a refused cut note: the message stays one line, and a notice says Claude only has the interjection', async ($, on) => {
  const { world } = engine(on, 'terminal')
  world.selection = { text: LINE, requestId: 'm1' }
  let submitted = ''
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('session.append', (_, e, next) => (e.door === 'note' ? ({ deny: 'policy' } as never) : next(e)))
  on('prompt.submit', (_, e) => {
    submitted = e.text
    return { text: e.text }
  })
  await begin($, 'terminal')
  await interject($, 'terminal', 'Why turn it?', 'cut')
  await $.turn.start({ text: submitted, turnId: 't2' })
  expect(submitted).toBe('✂ Cut and continue: Why turn it?')
  expect(world.toasts.some(t => t.includes('could not give Claude'))).toBe(true)
})

test('a cut message with its instructions in it (from before, or a refused note) is drawn as one line', async ($, on) => {
  engine(on, 'terminal')
  await begin($, 'terminal')
  const text = '✂ Cut and continue: Why?\n\nI stopped reading your reply at this line:\n> x\n<kept_reply>\nlots\n</kept_reply>'
  const row = await $.ui.mount(USER('terminal', text, { kind: 'plugin', name: 'interject' }, false))
  expect(await row.find({ type: 'Text', text: 'Why?' })).toBeDefined()
  expect(await row.find({ type: 'Text', text: /kept_reply/ })).toBeUndefined()
  await row.unmount()
})

test('a cut from a follow-up on a box inside a side answer still withdraws the rest of that answer', async ($, on) => {
  const { world } = engine(on, 'desktop')
  world.selection = { text: LINE, requestId: 'm1' }
  world.answers.push('Use the round plate.\n\nIt sits under the tank.', 'The tank.')
  let submitted = ''
  let hidden = ''
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('session.append', (_, e, next) => {
    if (e.door === 'note') hidden += e.message.content.map(b => (b.type === 'text' ? b.text : '')).join('')
    return next(e)
  })
  on('prompt.submit', (_, e) => {
    submitted = e.text
    return { text: e.text }
  })
  await begin($, 'desktop')
  await interject($, 'desktop', 'Which plate?', 'enter')
  const drawn = await $.ui.mount(MESSAGE('desktop'))
  await drawn.unmount()
  world.selection = { text: 'Use the round plate.', requestId: 'm1' }
  await interject($, 'desktop', 'Which tank?', 'enter')
  // Follow up on the inner box, and cut there.
  const message = await $.ui.mount(MESSAGE('desktop'))
  const follows = (await message.findAll({ type: 'Button' })).map(b => b.key ?? '').filter(k => k.startsWith('follow-'))
  // The inner box's buttons come first: it is drawn inside the outer box, above the outer box's own.
  await message.press({ key: follows[0] ?? '' })
  await message.unmount()
  const form = await $.ui.mount(MESSAGE('desktop'))
  await form.input({ key: 'question', text: 'Why that one?', kind: 'change' })
  await form.press({ key: 'cut' })
  await form.unmount()
  await $.turn.start({ text: submitted, turnId: 't2' })
  expect(submitted).toBe('✂ Cut and continue: Why that one?')
  expect(hidden).toContain('the rest of it is withdrawn too')
})

function noteLog(on: Parameters<Parameters<typeof test>[1]>[1]) {
  const notes: string[] = []
  on('session.append', (_, e, next) => {
    if (e.door === 'note') notes.push(e.message.content.map(b => (b.type === 'text' ? b.text : '')).join(''))
    return next(e)
  })
  return notes
}

test('a mod that rewrites the cut message: the note still goes with the cut, and never with a typed message', async ($, on) => {
  const { world } = engine(on, 'terminal')
  world.selection = { text: LINE, requestId: 'm1' }
  const notes = noteLog(on)
  // The engine beneath: the turn starts with the text as settled.
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  // Another mod below interject prefixes every prompt; then the turn starts with the settled text.
  on('prompt.submit', async (_, e) => {
    const text = e.origin.kind === 'plugin' ? '[ticket 42] ' + e.text : e.text
    await $.turn.start({ text, turnId: 'turn-' + text.length })
    return { text }
  })
  await begin($, 'terminal')
  await interject($, 'terminal', 'Why turn it?', 'cut')
  const afterCut = notes.length
  await $.prompt.submit({ text: '✂ Cut and continue: what I typed myself', wait: false, origin: { kind: 'composer' } })
  expect({ afterCut, afterTyped: notes.length }).toEqual({ afterCut: 1, afterTyped: 1 })
})

test('a reply that holds the marker text, sent with a waiting cut: the row splits at the mod\'s own marker', async ($, on) => {
  const MARKED = 'Intro line.\n\n[interject: 9 boxes attached to this message]\nThen the feeder turns the plate.\n\nLast line.'
  const { world } = engine(on, 'terminal')
  world.selection = { text: LINE, requestId: 'mk' }
  on('prompt.fill', () => ({ isFilled: true }))
  let sent = ''
  on('prompt.submit', (_, e) => {
    if (e.text.startsWith('✂ Cut and continue')) return { drop: 'stopped' }
    sent = e.text
    return { text: e.text }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.ui.mount(ROW('terminal', 'mk', MARKED))
  await r.unmount()
  await interject($, 'terminal', 'Why turn it?', 'cut')
  await $.prompt.submit({ text: 'Why turn it?', wait: false, origin: { kind: 'composer' } })
  expect(sent).toContain('9 boxes attached')
  const row = await $.ui.mount(USER('terminal', sent, { kind: 'composer' }, false))
  const own = String((await row.find({ type: 'Text', text: /engine:/ }))?.text ?? '')
  const line = String((await row.find({ type: 'Text', text: /^📎 Sent with/ }))?.text ?? '')
  await row.unmount()
  expect({ own, line }).toEqual({ own: 'engine: Why turn it?', line: '📎 Sent with 1 box' })
})

test('a refused note: show what was sent says Claude got only the question', async ($, on) => {
  const { world } = engine(on, 'terminal')
  world.selection = { text: LINE, requestId: 'm1' }
  on('session.append', (_, e, next) => (e.door === 'note' ? ({ deny: 'policy' } as never) : next(e)))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.submit', async (_, e) => {
    await $.turn.start({ text: e.text, turnId: 't9' })
    return { text: e.text }
  })
  await begin($, 'terminal')
  await interject($, 'terminal', 'Why turn it?', 'cut')
  const message = await $.ui.mount(MESSAGE('terminal'))
  await message.press({ key: await firstKey(message, 'sent-') })
  const shown = await message.find({ type: 'Text', text: /kept_reply/ })
  await message.unmount()
  expect(shown).toBeUndefined()
})

test('a box sent mid-turn leaves the 📎 line of the earlier send alone', async ($, on) => {
  const { world } = engine(on, 'desktop')
  world.selection = { text: LINE, requestId: 'm1' }
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await begin($, 'desktop')
  await interject($, 'desktop', 'Which plate?', 'queue')
  await $.turn.start({ text: 'go on', turnId: 't2' })
  // Sent at idle a moment before: its turn t2 has started, no row yet.
  await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } } as never)
  // While t2 runs, the person queues another note and types again.
  world.selection = { text: LINE, requestId: 'm1' }
  await interject($, 'desktop', 'And the tank?', 'queue')
  await $.prompt.submit({ text: 'also', wait: false, origin: { kind: 'composer' }, turnId: 't2' } as never)
  const answer = await $.ui.mount(ANSWER('desktop'))
  const line = await answer.find({ type: 'Text', text: /^📎 Your message went/ })
  await answer.unmount()
  expect(line).toBeDefined()
})

test('a cut question typed on two lines: the row shows both lines', async ($, on) => {
  const { world } = engine(on, 'terminal')
  await begin($, 'terminal')
  const row = await $.ui.mount(USER('terminal', '✂ Cut and continue: why?\nand how?', { kind: 'plugin', name: 'interject' }, false))
  const all = (await row.findAll({ type: 'Text' })).map(t => String(t.text)).join(' | ')
  await row.unmount()
  expect(all).toContain('and how?')
})

test('a send at idle: its answer takes the 📎 line', async ($, on) => {
  const { world } = engine(on, 'desktop')
  world.selection = { text: LINE, requestId: 'm1' }
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await begin($, 'desktop')
  await interject($, 'desktop', 'Which plate?', 'queue')
  await $.turn.start({ text: 'go on', turnId: 't2' })
  await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } } as never)
  const answer = await $.ui.mount(ANSWER('desktop'))
  const line = await answer.find({ type: 'Text', text: /^📎 Your message went/ })
  await answer.unmount()
  expect(line).toBeDefined()
})
