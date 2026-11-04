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

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type On = Parameters<Parameters<typeof test>[1]>[1]
type World = ReturnType<typeof engine>['world']

/** The world of the test running now, for the helpers below. */
let last: World

/** The world beneath the plugin, drawing on `surface`. `world.selection` is what the mouse last selected. */
function engine(on: On, surface: 'terminal' | 'desktop' | 'vscode' = 'terminal') {
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
  }
  last = world
  const clock = mock.clock(on)
  mock.store(on)
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
  on('ui.toast', () => ({ value: undefined }))
  on('ui.selection', () => ({ value: world.selection }))
  on('session.id', () => ({ value: 's1' }))
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
    on('prompt.submit', (_, e) => {
      sentContext = e.context ?? []
      return { text: e.text, context: e.context }
    })
    await begin($, surface)
    await interject($, surface, 'Which plate?', 'queue')

    const message = await $.ui.mount(MESSAGE(surface))
    expect(await message.find({ type: 'Text', text: /Which plate\?/ })).toBeDefined()
    expect(await message.find({ type: 'Text', text: /Will be attached to your next message/ })).toBeDefined()
    expect((await message.find({ type: 'Text', text: /engine:/ }))?.text).not.toContain('Finally')

    await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })
    expect(sentContext.length).toBe(1)
    expect(sentContext[0]).toContain('> Then the **feeder** turns the plate.')
    expect(sentContext[0]).toContain('Which plate?')

    await message.redraw()
    expect(await message.find({ type: 'Text', text: /Attached to your message/ })).toBeDefined()
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
    expect(await message.find({ type: 'Text', text: /\? Which tank\?/ })).toBeDefined()
    expect(await message.find({ type: 'Markdown', text: /40-litre tank/ })).toBeDefined()
    await message.unmount()
  })

  test(`keep: a side answer goes with the next prompt (${surface})`, async ($, on) => {
    const { world } = engine(on, surface)
    world.selection = { text: LINE, requestId: 'm1' }
    world.answers.push('The round feedplate.')
    let sentContext: readonly string[] = []
    on('prompt.submit', (_, e) => {
      sentContext = e.context ?? []
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

  test(`dismiss: a box kept deep inside a dismissed box is not sent (${surface})`, async ($, on) => {
    const { world } = engine(on, surface)
    world.selection = { text: LINE, requestId: 'm1' }
    world.answers.push('Use the round plate.\n\nIt sits under the tank.', 'The tank.\n\nIt holds 40 litres.', 'Water.')
    let sentContext: readonly string[] = []
    on('prompt.submit', (_, e) => {
      sentContext = e.context ?? []
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
    expect(await message.find({ type: 'Text', text: /\? Of what\?/ })).toBeDefined()
    // A box's buttons follow the boxes inside it: the first keep is the
    // innermost box's, the last dismiss the outermost's.
    await message.press({ key: await firstKey(message, 'keep-') })
    expect(await message.find({ type: 'Text', text: /Kept: goes with/ })).toBeDefined()
    const dismisses = (await message.findAll({ type: 'Button' })).map(b => b.key ?? '').filter(k => k.startsWith('dismiss-'))
    expect(dismisses.length).toBe(3)
    await message.press({ key: dismisses.at(-1) ?? '' })
    expect(await message.find({ type: 'Text', text: /\? Of what\?/ })).toBeUndefined()

    await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })
    expect(sentContext.join('\n')).not.toContain('Of what?')
    await message.unmount()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`cut and continue while Claude writes: stops the turn, sends the interjection, hides the rest (${surface})`, async ($, on) => {
    const { world } = engine(on, surface)
    world.selection = { text: LINE, requestId: 'm1' }
    let aborted = ''
    let submitted = ''
    on('turn.start', (_, e) => ({ turnId: e.turnId }))
    on('turn.abort', (_, e) => {
      aborted = e.turnId
      return { value: undefined }
    })
    on('prompt.submit', (_, e) => {
      submitted = e.text
      return { text: e.text }
    })
    await begin($, surface)
    await $.turn.start({ text: 'explain the rig', turnId: 't1' })
    await interject($, surface, 'Why turn it?', 'cut')

    expect(aborted).toBe('t1')
    expect(submitted).toContain('[interject: cut and continue]')
    expect(submitted).toContain('> Then the **feeder** turns the plate.')
    expect(submitted).toContain('My interjection: Why turn it?')
    expect(submitted).not.toContain('Finally the server saves the run.')

    const message = await $.ui.mount(MESSAGE(surface))
    expect(await message.find({ type: 'Text', text: /The rest of this reply \(1 line\) was cut/ })).toBeDefined()
    expect(await message.find({ type: 'Text', text: /✂ Why turn it\?/ })).toBeDefined()
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
    expect(await message.find({ type: 'Text', text: /\+ Which plate\?/ })).toBeDefined()
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
    if (e.text.startsWith('[interject')) return { drop: 'the session was stopped and nobody has sent input since' }
    sentContext = e.context ?? []
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
    sentContext = e.context ?? []
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
