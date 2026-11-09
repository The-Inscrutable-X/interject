// interject: stop at any line of Claude's reply and interject there.
//
// How the person uses it:
//   1. Select a line of a reply with the mouse (fullscreen terminal, Desktop).
//      A "✎ Interject here" button appears above the prompt: click it.
//      Or type /interject (with nothing selected, it lists the lines to pick).
//   2. A form opens right under the line (Desktop, VS Code), or a small panel
//      with the line quoted (the terminal, whose replies take no typing).
//      Type, and choose:
//        Ask on the side         a side chat: a fork of the conversation that
//                                can use tools works on it in the background,
//                                and answers in a box at that line, never
//                                added to the conversation
//        Quick answer (no tools) the same box, answered in one request over
//                                the conversation, in seconds
//        Add to my next message  attached as context to the next prompt sent
//        Cut here and continue   the reply after the line is withdrawn (and
//                                hidden), Claude is stopped if still writing,
//                                and continues from the interjection
//   3. Interject on interjections: select a line inside a side answer's box
//      and do the same; the new box sits at that line of the answer, and the
//      whole chain of earlier questions and answers goes with it.
//   A side answer's box offers "follow up" (another question at the same line),
//   "keep" (attach the exchange to the next message) and, on Desktop, "fork to
//   session" (the side chat goes on as a session of its own). /interject keep,
//   /interject followup and /interject clear do the same from the keyboard.
//   Boxes are saved per session and come back when the session is resumed.

import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement, RenderSurface } from 'claude-code'

import type { InterjectDraft, InterjectNote, InterjectPicked } from '../types'

const PANE = 'interject'
const MARK = '[interject: cut and continue]'
// The desktop app's tool that starts a session: a side chat forked out is one.
const START_SESSION = 'mcp__ccd_session__start_session'
const MAX_DEPTH = 4

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const notes = atom({ plugin: 'interject', key: 'notes' } as const, [] as InterjectNote[], {
  shape: 'notes-3',
})
const draft = atom({ plugin: 'interject', key: 'draft' } as const, null as InterjectDraft | null, {
  shape: 'draft-5',
})
const picked = atom({ plugin: 'interject', key: 'picked' } as const, null as InterjectPicked | null)

// Module memory: starts empty after a reload.
// The text of each reply block drawn so far, by its transcript id.
const seen = new Map<string, string>()
// The main conversation's running turn, so a cut can stop it.
let running: string | undefined
// A cut made while Claude was writing: the line where the stored reply ends.
let pendingCut: { quote: string; turnId: string } | undefined
// The selection last shown on the band, so it is drawn once per selection.
let shownSelection = ''
// Side chats: each one's current turn, so dismissing it can stop it; answers
// that came before their spawn resolved; spawns not yet resolved.
const agentTurns = new Map<string, string>()
const early = new Map<string, Pick<InterjectNote, 'status' | 'answer'>>()
let spawning = 0
// Side chats run outside the session, by box: dismiss stops one.
const outside = new Map<string, { stop: boolean }>()
// What is typed in the open form. Kept here, not in the draft, so a keystroke
// redraws nothing: a redraw per key made the field and every reply row flicker.
let typed = ''

// ---------------------------------------------------------------------------
// Lines of a text

/** The lines a person can pick: each non-blank source line, a fenced code block kept whole. */
function splitUnits(text: string): string[] {
  const units: string[] = []
  let fence: string[] | null = null
  for (const line of text.split('\n')) {
    const isFence = /^\s*(```|~~~)/.test(line)
    if (fence !== null) {
      fence.push(line)
      if (isFence) {
        units.push(fence.join('\n'))
        fence = null
      }
      continue
    }
    if (isFence) {
      fence = [line]
      continue
    }
    if (line.trim() !== '') units.push(line)
  }
  if (fence !== null) units.push(fence.join('\n'))
  return units
}

/**
 * Text with markdown marks, bullets and spacing taken out, for matching drawn
 * text to source. A desktop draws typographic punctuation (can’t, “so”, –, …)
 * where the source has typewriter marks, so quotes are dropped and dashes and
 * ellipses folded on both sides.
 */
function normalize(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/['"‘’‚‛“”„‟′″]/g, '')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/…/g, '...')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, ' ')
    .replace(/[`*_#>|~[\]()•●▪◦⎿│╭╮╰╯─]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** The index of the unit a selection starts in, or -1 when none matches. */
function findUnit(units: string[], selected: string): number {
  const first = selected
    .split('\n')
    .map(normalize)
    .find(line => line.length > 0)
  if (first === undefined) return -1
  const probe = first.slice(0, 60)
  const norms = units.map(normalize)
  const inside = norms.findIndex(unit => unit.includes(probe))
  if (inside >= 0) return inside
  return norms.findIndex(unit => unit.length >= 8 && probe.includes(unit))
}

/** Where unit `idx` ends in `text`, as an offset. */
function endOfUnit(text: string, units: string[], idx: number): number {
  let from = 0
  for (let k = 0; k <= idx; k++) {
    const unit = units[k]
    if (unit === undefined) return text.length
    const at = text.indexOf(unit, from)
    if (at < 0) return text.length
    from = at + unit.length
  }
  return from
}

/** Where the line `quote` ends in `text`; the end of the text when it is not found. */
function endOfQuote(text: string, quote: string): number {
  const units = splitUnits(text)
  const idx = findUnit(units, quote)
  return idx < 0 ? text.length : endOfUnit(text, units, idx)
}

type Anchor = { end: number; notes: InterjectNote[]; form?: true }

/** The boxes anchored in `text`, grouped by where their line ends, in order. */
function anchorsIn(text: string, list: InterjectNote[]): Anchor[] {
  const byEnd = new Map<number, InterjectNote[]>()
  for (const n of list) {
    const end = endOfQuote(text, n.quote)
    byEnd.set(end, [...(byEnd.get(end) ?? []), n])
  }
  return [...byEnd.entries()].sort((a, b) => a[0] - b[0]).map(([end, notes]) => ({ end, notes }))
}

/** The anchors with the open form at `end`, after the boxes already there. */
function withForm(anchors: Anchor[], end: number | undefined): Anchor[] {
  if (end === undefined) return anchors
  if (anchors.some(a => a.end === end)) return anchors.map(a => (a.end === end ? { ...a, form: true } : a))
  return [...anchors, { end, notes: [], form: true as const }].sort((a, b) => a.end - b.end)
}

// A box drawn at a row of a markdown table splits the table: the rows after it
// would have no header and be drawn as plain text. They get the header again.

type Table = { start: number; headEnd: number; end: number; head: string }

const isTableRule = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line) && line.includes('-')

/** The tables of `text` outside code fences, as offsets: the header row and rule line, then the rows. */
function tablesIn(text: string): Table[] {
  const lines = text.split('\n')
  const starts: number[] = []
  let at = 0
  for (const line of lines) {
    starts.push(at)
    at += line.length + 1
  }
  const endOf = (i: number) => (starts[i] ?? 0) + (lines[i] ?? '').length
  const tables: Table[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (inFence || !line.includes('|') || !isTableRule(lines[i + 1] ?? '')) continue
    let last = i + 1
    while ((lines[last + 1] ?? '').includes('|') && (lines[last + 1] ?? '').trim() !== '') last++
    tables.push({ start: starts[i] ?? 0, headEnd: endOf(i + 1), end: endOf(last), head: line + '\n' + (lines[i + 1] ?? '') })
    i = last
  }
  return tables
}

/** The anchors with none inside a table's header: a box there goes under the rule line. */
function fitTables(text: string, anchors: Anchor[]): Anchor[] {
  const tables = tablesIn(text)
  if (tables.length === 0) return anchors
  const merged = new Map<number, Anchor>()
  for (const a of anchors) {
    const t = tables.find(t => a.end > t.start && a.end < t.headEnd)
    const end = t === undefined ? a.end : t.headEnd
    const there = merged.get(end)
    merged.set(end, there === undefined ? { ...a, end } : { end, notes: [...there.notes, ...a.notes], form: there.form ?? a.form })
  }
  return [...merged.values()].sort((a, b) => a.end - b.end)
}

/** `text` from `from` to `end`, with the header again when it starts inside a table. */
function pieceOf(text: string, from: number, end?: number): string {
  const piece = text.slice(from, end).replace(/^\n+/, '')
  const t = tablesIn(text).find(t => from >= t.headEnd && from < t.end)
  return t === undefined ? piece : t.head + '\n' + piece
}

/** One line, cut to `n` characters. */
function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, Math.max(1, n - 1)) + '…' : one
}

/** The text up to and including the line (the last 6,000 characters of it). */
function upTo(text: string, quote: string): string {
  const cut = text.slice(0, endOfQuote(text, quote))
  return cut.length > 6000 ? '…' + cut.slice(-6000) : cut
}

const quoted = (s: string) => s.replace(/^/gm, '> ')

// ---------------------------------------------------------------------------
// Chains: an interjection on an answer, or a follow-up, builds on earlier ones

/** The notes a new interjection builds on, oldest first: follow-ups and the answers it sits in. */
function chainOf(list: InterjectNote[], from: string | undefined): InterjectNote[] {
  const chain: InterjectNote[] = []
  let at = from
  while (at !== undefined && chain.length < 12) {
    const n = list.find(m => m.id === at)
    if (n === undefined) break
    chain.unshift(n)
    at = n.parent ?? n.on
  }
  return chain
}

/** The earlier exchanges, as Claude reads them. */
function chainText(chain: InterjectNote[]): string[] {
  if (chain.length === 0) return []
  const lines = ['Earlier interjections in this thread, oldest first:']
  for (const n of chain) {
    lines.push('', 'At this line:', quoted(n.quote), 'The user asked: ' + n.question)
    if (n.answer !== undefined) lines.push('You answered on the side:', quoted(n.answer))
  }
  return lines
}

/** The line in the reply the whole chain starts from. */
function rootQuote(chain: InterjectNote[], quote: string): string {
  return chain[0]?.quote ?? quote
}

function sidePrompt(main: string, chain: InterjectNote[], quote: string, question: string): string {
  return [
    'This is a side chat. The user stopped reading your reply at one line to ask something on the side. Your answer is shown to them in a box at that line and is not added to the main conversation. Use tools as the question needs (read files, run commands, search the web); do what the question asks and no more, and end with your answer to it.',
    '',
    'Your reply, up to the point where the user stopped reading:',
    '<reply_so_far>',
    upTo(main, rootQuote(chain, quote)),
    '</reply_so_far>',
    '',
    ...chainText(chain),
    '',
    chain.length > 0 ? 'Now, at this line of your last side answer:' : 'The line the user is asking about:',
    quoted(quote),
    'Their question: ' + question,
  ].join('\n')
}

function queueContext(list: InterjectNote[], n: InterjectNote): string {
  return [
    'While reading your earlier reply, the user interjected.',
    ...chainText(chainOf(list, n.parent ?? n.on)),
    '',
    'At this line:',
    quoted(n.quote),
    'Their note or question: ' + n.question,
    'Take this into account in your answer.',
  ].join('\n')
}

function keptContext(list: InterjectNote[], n: InterjectNote): string {
  return [
    'While reading your earlier reply, the user asked side questions. They chose to keep this exchange: take it into account.',
    ...chainText(chainOf(list, n.id)),
  ].join('\n')
}

/** What Claude reads to cut its reply at a line and continue from the interjection. */
function cutInstructions(main: string, chain: InterjectNote[], quote: string): string {
  const root = rootQuote(chain, quote)
  return [
    'I stopped reading your reply at this line:',
    quoted(root),
    '',
    'Everything you wrote after that line is withdrawn: do not rely on it and do not repeat it. Your reply up to that line, for reference:',
    '<kept_reply>',
    upTo(main, root),
    '</kept_reply>',
    ...(chain.length > 0
      ? ['', ...chainText(chain), '', 'I stopped reading your last side answer at this line; the rest of it is withdrawn too:', quoted(quote)]
      : []),
  ].join('\n')
}

function cutPrompt(main: string, chain: InterjectNote[], quote: string, question: string): string {
  return [
    MARK,
    cutInstructions(main, chain, quote),
    '',
    'My interjection: ' + question,
    '',
    'Answer my interjection, then continue your reply from that line, taking it into account.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Where a selection lies

/** The text of the assistant message `back` replies before the latest, or '' when there is none. */
async function replyAt($: EngineInterface, back: number): Promise<string> {
  const messages = await $.session.messages()
  let skip = back
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message !== undefined && message.role === 'assistant' && message.text.trim() !== '') {
      if (skip === 0) return message.text
      skip -= 1
    }
  }
  return ''
}

/**
 * The panel's draft for a selection: at a line of a reply, or of a side
 * answer's box (an interjection on an interjection). Undefined when the
 * selection matches no line.
 */
function draftFor(list: InterjectNote[], selection: InterjectPicked, latest: string): InterjectDraft | undefined {
  const blank: Pick<InterjectDraft, 'stage' | 'back' | 'lines'> = { stage: 'type', back: 0, lines: [] }
  const fromRow = selection.requestId === undefined ? undefined : seen.get(selection.requestId)
  let requestId = selection.requestId
  let main = fromRow
  if (main === undefined) {
    for (const [id, text] of seen) {
      if (findUnit(splitUnits(text), selection.text) >= 0) {
        requestId = id
        main = text
        break
      }
    }
  }

  // A line of the reply itself.
  const source = main ?? latest
  const units = splitUnits(source)
  const idx = findUnit(units, selection.text)
  if (idx >= 0) {
    return { ...blank, requestId, reply: source, main: source, quote: units[idx] ?? selection.text }
  }

  // A line of a side answer drawn in that row: the newest answer that holds it.
  for (const n of [...list].reverse()) {
    if (n.answer === undefined || n.status !== 'answered') continue
    if (selection.requestId !== undefined && n.requestId !== selection.requestId) continue
    const answerUnits = splitUnits(n.answer)
    const at = findUnit(answerUnits, selection.text)
    if (at >= 0) {
      const rowText = n.requestId === undefined ? undefined : seen.get(n.requestId)
      return {
        ...blank,
        requestId: n.requestId,
        reply: n.answer,
        main: rowText ?? latest,
        quote: answerUnits[at] ?? selection.text,
        on: n.id,
      }
    }
  }

  // Selected in a row the mod has not seen as a reply: the end of that row.
  if (requestId !== undefined) {
    return { ...blank, requestId, reply: source, main: source, quote: selection.text.trim() }
  }
  return undefined
}

async function newId($: EngineInterface): Promise<string> {
  return String(await $.clock.now()) + '-' + Math.random().toString(36).slice(2, 7)
}

// ---------------------------------------------------------------------------
// Saving: each session's boxes in a folder of their own, as pages of JSON.
// Claude Code reads a file only up to 4 MiB, so a session's boxes are split
// into pages under that; with no limit on pages or sessions. It has no way to
// delete a file, so a page no longer needed is written empty ([]).

const PAGE_BYTES = 3 * 1024 * 1024

/** The folder that holds every session's boxes: INTERJECT_BOXES_DIR, or ~/.claude/interject-boxes. */
async function boxesDir($: EngineInterface): Promise<string> {
  const chosen = await $.env.get('INTERJECT_BOXES_DIR')
  if (chosen !== undefined && chosen.trim() !== '') return chosen.replace(/\/+$/, '')
  return ((await $.env.get('HOME')) ?? '') + '/.claude/interject-boxes'
}

/** `list` cut into pages of JSON text, each under PAGE_BYTES. */
function pagesOf(list: InterjectNote[]): string[] {
  const pages: string[] = []
  let page: string[] = []
  let size = 2
  for (const n of list) {
    const one = JSON.stringify(n)
    if (page.length > 0 && size + one.length + 1 > PAGE_BYTES) {
      pages.push('[' + page.join(',') + ']')
      page = []
      size = 2
    }
    page.push(one)
    size += one.length + 1
  }
  if (page.length > 0 || pages.length === 0) pages.push('[' + page.join(',') + ']')
  return pages
}

/** What each page file holds, as last written in this process, by path. */
const written = new Map<string, string>()
let saving: Promise<void> = Promise.resolve()

/** A session's saved boxes, every page in order; empty when none are saved. */
async function loadBoxes($: EngineInterface, id: string): Promise<InterjectNote[]> {
  const folder = (await boxesDir($)) + '/' + id
  if (!(await $.fs.exists(folder))) return []
  const pages = (await $.fs.list(folder))
    .map(f => /^(\d+)\.json$/.exec(f.name)?.[1])
    .filter((k): k is string => k !== undefined)
    .map(Number)
    .sort((a, b) => a - b)
  const all: InterjectNote[] = []
  for (const k of pages) {
    try {
      const path = folder + '/' + k + '.json'
      const text = String(await $.fs.read(path))
      // Known as written, so a later save empties it when it is left over.
      written.set(path, text)
      const page = JSON.parse(text)
      if (Array.isArray(page)) all.push(...(page as InterjectNote[]))
    } catch {
      // A page cut short (the app quit while writing it): the rest still load.
    }
  }
  return all
}

/** Writes this session's boxes as they stand now: the pages that changed, and [] in pages left over. */
function saveBoxes($: EngineInterface): Promise<void> {
  saving = saving.then(async () => {
    try {
      const folder = (await boxesDir($)) + '/' + (await $.session.id())
      const pages = pagesOf(await read($, notes))
      const before = [...written.keys()].filter(k => k.startsWith(folder + '/')).length
      for (let k = 0; k < Math.max(pages.length, before); k++) {
        const path = folder + '/' + k + '.json'
        const text = pages[k] ?? '[]'
        if (written.get(path) === text) continue
        await $.fs.write(path, text)
        written.set(path, text)
      }
    } catch (err) {
      $.ui.toast("Interject could not save this session's boxes: " + clip(String(err), 120))
    }
  })
  return saving
}

/** Moves boxes the mod's store held (before the folder) into the folder, once. */
async function moveFromStore($: EngineInterface): Promise<void> {
  const keys = (await $.store.keys()).filter(k => k.startsWith('notes:'))
  const dir = await boxesDir($)
  for (const key of keys) {
    const list = await $.store.get(key)
    const folder = dir + '/' + key.slice('notes:'.length)
    if (Array.isArray(list) && list.length > 0 && !(await $.fs.exists(folder))) {
      const pages = pagesOf(list as InterjectNote[])
      for (const [k, text] of pages.entries()) await $.fs.write(folder + '/' + k + '.json', text)
    }
    await $.store.delete(key)
  }
  if ((await $.store.get('sessions')) !== undefined) await $.store.delete('sessions')
}

// The boxes are held in the mod's state to be drawn, and Claude Code caps a
// state value at 4 MiB of JSON: about 2,000 boxes of a session. Past that the
// session's oldest boxes are let go.
const STATE_LIMIT = 4_000_000

/** `list` with its oldest boxes (and the boxes inside them) dropped until it fits the state's cap. */
function fitBoxes(list: InterjectNote[]): { list: InterjectNote[]; dropped: number } {
  let kept = list
  let size = JSON.stringify(kept).length
  while (size > STATE_LIMIT && kept.length > 1) {
    const oldest = kept[0]
    if (oldest === undefined) break
    const gone = boxesUnder(kept, oldest.id)
    kept = kept.filter(m => !gone.has(m.id))
    size = JSON.stringify(kept).length
  }
  return { list: kept, dropped: list.length - kept.length }
}

/** The notice when a session's oldest boxes were let go. */
function fullNotice(dropped: number): string {
  return 'Interject: this session holds the most boxes it can, so its ' + dropped + ' oldest ' + (dropped === 1 ? 'box was' : 'boxes were') + ' removed.'
}

/** Changes the boxes, and saves them for this session so a resume brings them back. */
async function setNotes($: EngineInterface, change: (list: InterjectNote[]) => InterjectNote[]): Promise<void> {
  let dropped = 0
  await update($, notes, list => {
    const fitted = fitBoxes(change(list))
    dropped = fitted.dropped
    return fitted.list
  })
  if (dropped > 0) $.ui.toast(fullNotice(dropped))
  await saveBoxes($)
}

async function openPane($: EngineInterface, rows: number): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Interject', focus: true, closeOnEscape: true, rows })
}

/**
 * Whether the form is drawn under the line in its row: a Desktop or VS Code
 * row takes a text field, a terminal's does not. `surface` is where the
 * person pressed; unknown (a typed /interject), any such surface attached.
 */
async function drawsInline($: EngineInterface, surface: RenderSurface | undefined): Promise<boolean> {
  if (surface !== undefined) return surface === 'desktop' || surface === 'vscode'
  return (await $.session.surfaces()).some(s => s === 'desktop' || s === 'vscode')
}

/** The reply row a line lies in, by the rows drawn so far: the latest that holds it. */
function rowOf(quote: string): string | undefined {
  let found: string | undefined
  for (const [id, text] of seen) if (findUnit(splitUnits(text), quote) >= 0) found = id
  return found
}

/** The row a reply ends in, by the rows drawn so far. */
function lastRowOf(reply: string): string | undefined {
  const units = splitUnits(reply)
  for (let i = units.length - 1; i >= 0; i--) {
    const row = rowOf(units[i] ?? '')
    if (row !== undefined) return row
  }
  return undefined
}

/**
 * Shows the form for `next`: under its line where the surface can, else in
 * the panel. False when the surface draws in rows but the line's row is not
 * known: the panel is not opened there, as it pushes the reply aside.
 */
async function openForm($: EngineInterface, next: InterjectDraft, surface?: RenderSurface): Promise<boolean> {
  typed = ''
  const requestId = next.requestId ?? rowOf(next.quote)
  if (await drawsInline($, surface)) {
    if (requestId === undefined) return false
    await update($, draft, (): InterjectDraft => ({ ...next, requestId, inline: true }))
    return true
  }
  await update($, draft, (): InterjectDraft => ({ ...next, inline: undefined }))
  await openPane($, 10)
  return true
}

/**
 * The list of a reply's lines to pick from: at the end of that reply where
 * the surface draws in rows (below what the person is reading, so nothing
 * moves), else in the panel. Returns a message when there is nowhere to show it.
 */
async function openPick($: EngineInterface, reply: string, back: number, surface?: RenderSurface): Promise<string | undefined> {
  typed = ''
  const pick: InterjectDraft = { stage: 'pick', reply, main: reply, back, lines: splitUnits(reply), quote: '' }
  if (await drawsInline($, surface)) {
    const requestId = lastRowOf(reply)
    if (requestId === undefined) return 'Scroll to the reply, then select a line in it and click ✎ Interject here.'
    await update($, draft, (): InterjectDraft => ({ ...pick, requestId, inline: true }))
    return undefined
  }
  await update($, draft, (): InterjectDraft => ({ ...pick, inline: undefined }))
  await openPane($, 14)
  return undefined
}

/** Takes the form away: the panel closes, a form under a line is no longer drawn. */
async function closeForm($: EngineInterface): Promise<void> {
  const d = await read($, draft)
  typed = ''
  await update($, draft, () => null)
  if (d?.inline !== true) await $.ui.close({ id: PANE })
}

/** A line picked from the list: typed under that line where the surface can, else in the panel. */
async function pickLine($: EngineInterface, line: string, surface: RenderSurface): Promise<void> {
  const d = await read($, draft)
  if (d === null) return
  // A reply's text blocks are rows of their own: the line's, before the reply's last.
  const row = rowOf(line) ?? d.requestId
  const inline = row !== undefined && (await drawsInline($, surface))
  typed = ''
  await update($, draft, (c): InterjectDraft | null =>
    c === null ? c : { ...c, stage: 'type', quote: line, requestId: inline ? row : c.requestId, inline },
  )
  if (inline && d.inline !== true) await $.ui.close({ id: PANE })
}

/** The list moves to the reply `back` replies before the latest. */
async function showReply($: EngineInterface, back: number, surface: RenderSurface): Promise<void> {
  const text = await replyAt($, back)
  if (text === '') return
  const message = await openPick($, text, back, surface)
  if (message !== undefined) $.ui.toast(message)
}

/**
 * Opens the form for the current selection, or a list of the last reply's
 * lines when nothing is selected. Returns a message when there is nothing to
 * interject on.
 */
async function start($: EngineInterface, surface?: RenderSurface): Promise<string | undefined> {
  // A click on ✎ can clear a desktop's selection before it is read: the one
  // the band was showing stands in.
  const live = await $.ui.selection()
  const selected = live !== undefined && live.text.trim() !== '' ? live : await read($, picked)
  const latest = await replyAt($, 0)
  await update($, picked, () => null)

  if (selected !== null && selected.text.trim() !== '') {
    const next = draftFor(await read($, notes), selected, latest)
    if (next !== undefined && (await openForm($, next, surface))) return undefined
  }

  if (latest === '') return 'Nothing to interject on yet: Claude has not replied in this conversation.'
  return openPick($, latest, 0, surface)
}

/** Opens the form to ask a follow-up about the line of side question `n`. */
async function followUp($: EngineInterface, n: InterjectNote, main: string, surface?: RenderSurface): Promise<void> {
  const list = await read($, notes)
  const container = n.on === undefined ? undefined : list.find(m => m.id === n.on)
  const opened = await openForm(
    $,
    {
      stage: 'type',
      requestId: n.requestId,
      reply: container?.answer ?? main,
      main,
      back: 0,
      lines: [],
      quote: n.quote,
      on: n.on,
      parent: n.id,
    },
    surface,
  )
  if (!opened) $.ui.toast('Scroll to that box, then click follow up under it.')
}

/** Marks side answer `id` to go with the next message. */
async function keep($: EngineInterface, id: string): Promise<void> {
  await setNotes($, list => list.map((m): InterjectNote => (m.id === id ? { ...m, keep: 'queued' } : m)))
}

/** The latest answered side question, for the keyboard forms of follow up and keep. */
async function latestAnswered($: EngineInterface): Promise<InterjectNote | undefined> {
  const list = await read($, notes)
  return [...list].reverse().find(n => n.mode === 'side' && n.status === 'answered')
}

// ---------------------------------------------------------------------------
// The form's three choices, from the panel or from under the line

/**
 * Side question: a box at the line, answered over the conversation so far,
 * never added to it. With tools, by a fork that works in the background; a
 * quick answer, by one request over the conversation, in seconds.
 */
async function askAside($: EngineInterface, typed: string, tools = true): Promise<void> {
  const d = await read($, draft)
  const question = typed.trim()
  if (d === null || question === '') return
  const id = await newId($)
  const chain = chainOf(await read($, notes), d.parent ?? d.on)
  const note: InterjectNote = {
    id,
    requestId: d.requestId,
    quote: d.quote,
    question,
    mode: 'side',
    status: 'thinking',
    on: d.on,
    parent: d.parent,
  }
  await setNotes($, list => [...list, note])
  await closeForm($)
  const prompt = sidePrompt(d.main, chain, d.quote, question)
  if (tools) await runAgent($, id, prompt, question)
  else await answerWithoutTools($, id, prompt)
}

/** A quick answer asked again, this time by a side chat that can use tools. */
async function withTools($: EngineInterface, n: InterjectNote, main: string): Promise<void> {
  const chain = chainOf(await read($, notes), n.parent ?? n.on)
  await setNotes($, list =>
    list.map((m): InterjectNote =>
      m.id === n.id
        ? { ...m, status: 'thinking', answer: undefined, noTools: undefined, steps: undefined, agentId: undefined, outside: undefined }
        : m,
    ),
  )
  await runAgent($, n.id, sidePrompt(main, chain, n.quote, n.question), n.question)
}

/** Starts the side chat's agent for box `id`: a fork, the whole conversation and its tools, in the background. */
async function runAgent($: EngineInterface, id: string, prompt: string, question: string): Promise<void> {
  spawning += 1
  let spawned
  try {
    spawned = await $.agent.spawn({ prompt, subagentType: 'fork', description: sideDescription(question) })
  } finally {
    spawning -= 1
  }
  const agentId = spawned.agentId
  if (spawned.deny !== undefined || agentId === undefined) {
    // Runs on after the press that asked: the child lives as long as its loop.
    void runOutside($, id, prompt, spawned.deny ?? 'its agent did not start')
    return
  }
  const done = early.get(agentId)
  early.delete(agentId)
  await setNotes($, list => list.map((n): InterjectNote => (n.id === id ? { ...n, agentId, ...done } : n)))
}

/**
 * The session would not start the side chat's agent. In a Desktop session in
 * auto mode it never does: the app gives the session auto mode rules of its
 * own, and with rules set a call a plugin makes is put to the server-side
 * check, which judges only calls a reply of Claude's asked for. So the side
 * chat runs as a fork of the conversation in a Claude Code process of its
 * own, unsaved, where auto mode judges each tool call it makes against the
 * question it was asked. Outside auto mode it runs in default mode, where a
 * call that would need approval is refused, as nobody can be asked there.
 */
async function runOutside($: EngineInterface, id: string, prompt: string, deny: string): Promise<void> {
  const mode = /auto mode/i.test(deny) ? 'auto' : 'default'
  const run = { stop: false }
  outside.set(id, run)
  await setNotes($, list => list.map((n): InterjectNote => (n.id === id ? { ...n, outside: true } : n)))
  let answer: string | undefined
  let failed: string | undefined
  try {
    const child = $.process.spawn({
      argv: [
        'claude',
        '-p',
        prompt,
        '--resume',
        await $.session.id(),
        '--fork-session',
        '--no-session-persistence',
        '--model',
        await $.session.model(),
        '--permission-mode',
        mode,
        '--output-format',
        'stream-json',
        '--verbose',
      ],
      env: CHILD_ENV,
    })
    let pending = ''
    for await (const piece of child) {
      if (run.stop) break
      if (piece.stream !== 'stdout') continue
      pending += piece.text
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const event = parseLine(line)
        if (event === undefined) continue
        const calls = (event.type === 'assistant' ? (event.message?.content ?? []) : []).filter(c => c.type === 'tool_use')
        if (calls.length > 0) {
          const steps = calls.map(c => describeCall({ tool: c.name ?? 'tool', ...(c.input ?? {}) }))
          await setNotes($, list =>
            list.map((n): InterjectNote => (n.id === id ? { ...n, steps: [...(n.steps ?? []), ...steps].slice(-6) } : n)),
          )
        }
        if (event.type === 'result') {
          if (event.is_error === true || typeof event.result !== 'string' || event.result.trim() === '') {
            failed = clip(typeof event.result === 'string' && event.result !== '' ? event.result : (event.subtype ?? 'no answer'), 200)
          } else {
            answer = event.result
          }
        }
      }
    }
  } catch (err) {
    failed = 'the side chat could not start (' + clip(String(err), 120) + ')'
  } finally {
    outside.delete(id)
  }
  if (run.stop) return
  if (answer !== undefined) {
    await setNotes($, list => list.map((n): InterjectNote => (n.id === id ? { ...n, status: 'answered', answer } : n)))
    return
  }
  await answerWithoutTools($, id, prompt, deny, failed ?? 'it ended without an answer')
}

// The app's own ties to this session are not a child's: a child answers nobody.
const CHILD_ENV = {
  CLAUDE_CODE_HOST_SESSION_ID: '',
  CLAUDE_CODE_SESSION_NAME: '',
  CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: '',
  CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '',
  CLAUDE_CODE_SDK_READS_SESSION_STATE: '',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
}

type StreamEvent = {
  type?: string
  session_id?: unknown
  subtype?: string
  is_error?: boolean
  result?: unknown
  message?: { content?: { type?: string; name?: string; input?: Record<string, unknown> }[] }
}

/** One line of the child's stream-json output, or undefined when it is not one. */
function parseLine(line: string): StreamEvent | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null ? (value as StreamEvent) : undefined
  } catch {
    return undefined
  }
}

/** What a side chat's agent shows as in the app's list of background tasks. */
function sideDescription(question: string): string {
  return 'Interject: ' + clip(question, 40)
}

/**
 * One completion over the conversation answers, without tools: a quick
 * answer, or the side chat's agent was not let start (`deny`), which the box
 * then says.
 */
async function answerWithoutTools($: EngineInterface, id: string, prompt: string, deny?: string, seen?: string): Promise<void> {
  const why = deny === undefined ? undefined : /auto mode/i.test(deny) ? 'auto mode did not let a side agent start' : clip(deny, 100)
  const plain = prompt.replace('Use tools as the question needs (read files, run commands, search the web); do what', 'You have no tools here: answer from what you know, and do what')
  let r = await $.model.fork({ prompt: plain })
  if (!r.isAnswered && r.reason === 'nothing-to-fork') r = await $.model.complete({ model: await $.session.model(), prompt: plain, maxTokens: 4096 })
  const noTools = why === undefined ? 'Quick answer, without tools.' : 'Answered without tools: ' + why + (seen === undefined ? '.' : ' (' + seen + ').')
  const result: Pick<InterjectNote, 'status' | 'answer' | 'noTools'> = r.isAnswered
    ? { status: 'answered', answer: r.text, noTools }
    : { status: 'failed', answer: why === undefined ? 'No answer (' + r.reason + ').' : 'No side chat: ' + why + ', and the plain answer failed (' + r.reason + ').' }
  await setNotes($, list => list.map((n): InterjectNote => (n.id === id ? { ...n, ...result } : n)))
}

/** A side chat's agent ended its turn: its answer goes in the box. */
async function sideFinished(
  $: EngineInterface,
  agentId: string,
  e: { answer: string; isAborted: boolean; reason: string },
): Promise<void> {
  agentTurns.delete(agentId)
  const answered = e.reason === 'answer' && e.answer.trim() !== ''
  const result: Pick<InterjectNote, 'status' | 'answer'> = {
    status: answered ? 'answered' : 'failed',
    answer: answered ? e.answer : e.isAborted ? 'Stopped before it answered.' : 'No answer (' + e.reason + ')',
  }
  if (!(await read($, notes)).some(n => n.agentId === agentId)) {
    // Ours, perhaps, with its spawn not yet resolved.
    if (spawning > 0) early.set(agentId, result)
    return
  }
  await setNotes($, list => list.map((n): InterjectNote => (n.agentId === agentId ? { ...n, ...result } : n)))
}

/** One line for a tool call a side chat's agent made: the tool and what it was given. */
function describeCall(e: { tool: string }): string {
  const input = e as unknown as Record<string, unknown>
  const arg = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description']
    .map(k => input[k])
    .find((v): v is string => typeof v === 'string' && v.trim() !== '')
  const name = e.tool.replace(/^mcp__.+?__/, '')
  return arg === undefined ? name : name + ' ' + clip(arg, 60)
}

/** A box and every box drawn inside it, however deep. */
function boxesUnder(list: InterjectNote[], id: string): Set<string> {
  const ids = new Set([id])
  for (let grew = true; grew; ) {
    grew = false
    for (const m of list) {
      if (m.on !== undefined && ids.has(m.on) && !ids.has(m.id)) {
        ids.add(m.id)
        grew = true
      }
    }
  }
  return ids
}

/** Takes a box away, with the boxes inside it; a side chat still working is stopped. */
async function dismiss($: EngineInterface, n: InterjectNote): Promise<void> {
  const list = await read($, notes)
  const gone = boxesUnder(list, n.id)
  for (const m of [n, ...list.filter(m => m.id !== n.id && gone.has(m.id))]) {
    const run = outside.get(m.id)
    if (run !== undefined) run.stop = true
    const turnId = m.agentId === undefined ? undefined : agentTurns.get(m.agentId)
    if (m.status === 'thinking' && turnId !== undefined) {
      try {
        await $.turn.abort({ turnId })
      } catch {
        // It ended on its own meanwhile.
      }
    }
  }
  await setNotes($, all => {
    const under = boxesUnder(all, n.id)
    return all.filter(m => !under.has(m.id))
  })
}

/** The fork's title: what the sidebar shows. */
function forkTitle(n: InterjectNote): string {
  return clip('Side chat: ' + n.question, 58)
}

/** The brief a fork starts from: the side chat, which the conversation never saw. */
function forkBrief(list: InterjectNote[], n: InterjectNote): string {
  return [
    'This session is a fork of a side chat. In the conversation above, the user stopped reading a reply at one line and asked on the side; that side chat was answered in a box at the line, outside the conversation. It goes on here, as a conversation of its own: the user will reply in this session.',
    '',
    ...chainText(chainOf(list, n.id)),
    '',
    'This is not a task: carry on with nothing from the conversation above, and use no tools now. Reply with one short line saying you are ready to go on with this side chat, then wait for the user.',
  ].join('\n')
}

/**
 * Fork to session: the side chat goes on as a session of its own. First a
 * New task card from the desktop app's own tool: Start on it opens the fork
 * listed under this session. Where the app or auto mode refuses the card, a
 * fork of its own, opened in the app by its Resume link.
 */
async function forkOut($: EngineInterface, n: InterjectNote): Promise<void> {
  const prompt = forkBrief(await read($, notes), n)
  const setForked = (forked: string | undefined) =>
    setNotes($, all => all.map((m): InterjectNote => (m.id === n.id ? { ...m, forked } : m)))
  await setForked('Forking it…')
  const card = await forkByCard($, n, prompt)
  if (card === true) {
    await setForked('Press Start on the New task card at the end of the conversation: the side chat opens as a session under this one.')
    return
  }
  await setForked('Forking it into a session of its own…')
  // Runs on after the press: the fork takes one request over the whole conversation.
  void (async () => {
    // A side chat that had to run outside the session is in auto mode; the fork keeps it.
    if (await forkByLink($, prompt, forkTitle(n), n.outside === true ? 'auto' : 'default')) {
      await setForked('Forked into a session of its own: it opened in Claude, and it is in the sidebar.')
      return
    }
    await setForked(undefined)
    $.ui.toast('The side chat was not forked: ' + clip(card, 120))
  })()
}

/**
 * Forks the conversation into a saved Claude Code session, one short turn
 * that takes the side chat in, and has the desktop app import and open it
 * by its Resume link. No tool call, so a session in auto mode, whose check
 * refuses a call a plugin makes, does not stand in the way. False when any
 * step fails.
 */
async function forkByLink($: EngineInterface, prompt: string, title: string, mode: 'auto' | 'default'): Promise<boolean> {
  try {
    const fork = await $.process.run(
      [
        'claude',
        '-p',
        prompt,
        '--resume',
        await $.session.id(),
        '--fork-session',
        '--name',
        title,
        '--model',
        await $.session.model(),
        '--permission-mode',
        mode,
        '--max-turns',
        '1',
        '--output-format',
        'json',
      ],
      { env: CHILD_ENV, timeoutMs: 300000 },
    )
    const sessionId = fork.exitCode === 0 ? parseLine(fork.stdout.trim())?.session_id : undefined
    if (typeof sessionId !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) return false
    const open = await $.process.run(['open', 'claude://resume?session=' + sessionId])
    return open.exitCode === 0
  } catch {
    return false
  }
}

/**
 * A New task card for the fork, by the desktop app's own tool: the person
 * presses Start, and the app opens it under this session. A card, not a
 * start: the app starts a session at once only on the person's own typed
 * words, and a press on the box is not that. In auto mode the call needs an
 * allow rule for the tool, as auto mode's check refuses a call a plugin makes.
 * True when the card is shown; else why not.
 */
async function forkByCard($: EngineInterface, n: InterjectNote, prompt: string): Promise<true | string> {
  try {
    const result = await $.tool.call({
      tool: START_SESSION,
      initiation: 'own_initiative',
      title: forkTitle(n),
      context: 'fork',
      prompt,
      // The app's tool is connected at run time, not in the tool types this mod is built against.
    } as unknown as Parameters<EngineInterface['tool']['call']>[0])
    if (result.deny === undefined && result.isError !== true) return true
    return result.deny ?? result.text ?? 'the app refused'
  } catch {
    return 'it needs Claude Code Desktop'
  }
}

/** Add to next message: kept as queued until the next prompt is sent. */
async function addToNext($: EngineInterface): Promise<void> {
  const d = await read($, draft)
  const question = typed.trim()
  if (d === null || question === '') return
  const id = await newId($)
  const note: InterjectNote = {
    id,
    requestId: d.requestId,
    quote: d.quote,
    question,
    mode: 'queue',
    status: 'queued',
    on: d.on,
    parent: d.parent,
  }
  await setNotes($, list => [...list, note])
  await closeForm($)
}

/**
 * Cut here and continue: stop Claude if it is still writing, withdraw the
 * reply after the line, and send the interjection so Claude continues.
 */
async function cutHere($: EngineInterface): Promise<void> {
  const d = await read($, draft)
  const question = typed.trim()
  if (d === null || question === '') return
  const id = await newId($)
  const chain = chainOf(await read($, notes), d.parent ?? d.on)
  const note: InterjectNote = {
    id,
    requestId: d.requestId,
    quote: d.quote,
    question,
    mode: 'cut',
    status: 'continuing',
    on: d.on,
    parent: d.parent,
  }
  await setNotes($, list => [...list, note])
  await closeForm($)

  const turnId = running
  if (turnId !== undefined) {
    // The part still being written is stored ending at the line (session.append below).
    pendingCut = { quote: rootQuote(chain, d.quote), turnId }
    try {
      await $.turn.abort({ turnId })
    } catch {
      // The turn ended on its own meanwhile.
    }
  }

  const sent = await $.prompt.submit({ text: cutPrompt(d.main, chain, d.quote, question), asUser: true })
  if (sent.drop !== undefined) {
    // Not sent (for one, the person stopped Claude themselves): the person sends it.
    const pending =
      cutInstructions(d.main, chain, d.quote) +
      '\n\nAnswer my interjection (my message), then continue your reply from that line, taking it into account.'
    await setNotes($, list => list.map((n): InterjectNote => (n.id === id ? { ...n, status: 'waiting', pending } : n)))
    await $.prompt.fill({ text: question })
    $.ui.toast('Press Enter to send your interjection and continue from the cut')
  }
}

type FormElements = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button' | 'Input'>

/**
 * The field and the choices, each on its own full-width row. In the panel the
 * line is quoted above them; under the line itself it is a box like the
 * interjection it will become.
 */
function formTree($: EngineInterface, { Box, Text, Button, Input }: FormElements, current: InterjectDraft, width: number): RenderElement {
  const inline = current.inline === true
  const body = [
    inline ? (
      <Text color="warning" weight="semibold">
        ✎ Interject at this line
      </Text>
    ) : (
      <Box borderStyle="quote" borderColor="warning">
        <Text dimColor>{clip(current.quote, width * 3)}</Text>
      </Box>
    ),
    current.on !== undefined && <Text dimColor>On a side answer: the earlier questions and answers go with it.</Text>,
    current.parent !== undefined && <Text dimColor>Follow-up: the earlier side questions about this line go with it.</Text>,
    <Box flexDirection="column" width="100%">
      {/* A desktop draws what Enter does beside the field: a key's hint, not the button's words again. */}
      <Input
        key="question"
        autoFocus
        rows={3}
        placeholder="Your question or note"
        value={typed}
        submitLabel="Enter ↵"
        onInput={value => {
          typed = value
        }}
        onSubmit={value => askAside($, value)}
      />
    </Box>,
    // Wraps onto more rows in a narrow side panel rather than running past its edge.
    <Box flexDirection="row" flexWrap="wrap" gap={1} width="100%">
      <Button key="side" variant="primary" label="Ask on the side" onPress={() => askAside($, typed)} />
      <Button key="quick" label="Quick answer (no tools)" onPress={() => askAside($, typed, false)} />
      <Button key="queue" label="Add to my next message" onPress={() => addToNext($)} />
      <Button key="cut" label="Cut here and continue" onPress={() => cutHere($)} />
      {/* In a reply row a dismiss role would put a desktop's close mark at the row's edge: plain there. */}
      {inline ? (
        <Button key="cancel" label="Cancel" onPress={() => closeForm($)} />
      ) : (
        <Button key="cancel" label="Cancel" role="dismiss" onPress={() => closeForm($)} />
      )}
    </Box>,
  ]
  return inline ? (
    <Box flexDirection="column" gap={1} width="100%" borderStyle="round" borderColor="warning" paddingX={1} paddingY={1}>
      {body}
    </Box>
  ) : (
    <Box flexDirection="column">{body}</Box>
  )
}

/** The list of a reply's lines to pick from: in the panel, or boxed at the end of the reply. */
function pickTree($: EngineInterface, { Box, Text, Button }: FormElements, current: InterjectDraft, width: number): RenderElement {
  const inline = current.inline === true
  const back = current.back > 0 ? ' (' + current.back + (current.back === 1 ? ' reply back)' : ' replies back)') : ''
  const body = [
    inline ? (
      <Text color="warning" weight="semibold">
        {'✎ Which line? Click one.' + back}
      </Text>
    ) : (
      <Text weight="semibold">{'Which line? Arrow keys and Enter, or click.' + back}</Text>
    ),
    ...current.lines.map((line, i) => (
      <Button key={'line-' + i} plain onPress={press => pickLine($, line, press.surface)}>
        {/* Cut by the surface at its real edge: a desktop's buttons are wider than bodyColumns counts. */}
        <Text wrap="truncate-end">{clip(line, width)}</Text>
      </Button>
    )),
    <Box flexDirection="row" flexWrap="wrap" gap={1} width="100%">
      <Button key="earlier" label="Earlier reply" onPress={press => showReply($, current.back + 1, press.surface)} />
      {current.back > 0 && (
        <Button key="later" label="Later reply" onPress={press => showReply($, current.back - 1, press.surface)} />
      )}
      {inline ? (
        <Button key="cancel" label="Cancel" onPress={() => closeForm($)} />
      ) : (
        <Button key="cancel" label="Cancel" role="dismiss" onPress={() => closeForm($)} />
      )}
    </Box>,
  ]
  return inline ? (
    <Box flexDirection="column" width="100%" borderStyle="round" borderColor="warning" paddingX={1} paddingY={1}>
      {body}
    </Box>
  ) : (
    <Box flexDirection="column">{body}</Box>
  )
}

// ---------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'interject',
      description: 'Interject at a line of the reply: select it first, or pick it from a list',
      argumentHint: '[ask <question> | followup | keep | fork | clear]',
      immediate: true,
    })

    // Bring back this session's boxes after a resume, from their folder.
    const id = await $.session.id()
    try {
      await moveFromStore($)
    } catch {
      // The store's boxes stay where they are, to move next time.
    }
    const saved = await loadBoxes($, id).catch((): InterjectNote[] => [])
    if (saved.length > 0 && (await read($, notes)).length === 0) {
      const restored = saved.map((n): InterjectNote =>
        n.status === 'thinking' ? { ...n, status: 'failed', answer: 'Interrupted before it answered.' } : n,
      )
      const fitted = fitBoxes(restored)
      await update($, notes, () => fitted.list)
      if (fitted.dropped > 0) $.ui.toast(fullNotice(fitted.dropped))
    }

    // Watch the mouse selection, so the band can offer "Interject here".
    // A press on ✎ clears the selection a moment before the button runs, so a
    // selection that goes empty is kept a little longer (three checks, about a
    // second): a check landing between the press and the release would
    // otherwise forget it, and ✎ would open the list of lines instead.
    let emptyChecks = 0
    $.clock.every(400, async () => {
      const selection = await $.ui.selection()
      const text = selection?.text.trim() ?? ''
      if (text === '') {
        emptyChecks += 1
        if (emptyChecks < 3) return
      } else {
        emptyChecks = 0
      }
      const key = text === '' ? '' : (selection?.requestId ?? '') + '\n' + text
      if (key === shownSelection) return
      shownSelection = key
      await update($, picked, () => (text === '' ? null : { text, requestId: selection?.requestId }))
    })
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) running = e.turnId
    else agentTurns.set(e.agentId, e.turnId)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      if (e.turnId === running) running = undefined
      if (pendingCut !== undefined && pendingCut.turnId !== e.turnId) pendingCut = undefined
    } else {
      await sideFinished($, e.agentId, e)
    }
    return next(e)
  })

  // What a side chat's agent does, shown in its box while it works.
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId !== undefined && (await read($, notes)).some(n => n.agentId === agentId && n.status === 'thinking')) {
      const step = describeCall(e)
      await setNotes($, list =>
        list.map((n): InterjectNote => (n.agentId === agentId ? { ...n, steps: [...(n.steps ?? []), step].slice(-6) } : n)),
      )
    }
    return next(e)
  })

  // /interject: start an interjection at the selected line, or offer a list.
  on('command.run', { command: 'interject' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'ask' || arg.startsWith('ask ')) {
      // A side question at the last line of the latest reply, from the keyboard.
      const question = e.args.trim().slice(3).trim()
      if (question === '') return { text: 'Usage: /interject ask <your question>' }
      const latest = await replyAt($, 0)
      const last = splitUnits(latest).at(-1)
      if (last === undefined) return { text: 'Nothing to interject on yet: Claude has not replied in this conversation.' }
      await update($, draft, (): InterjectDraft => ({
        stage: 'type',
        requestId: lastRowOf(latest),
        reply: latest,
        main: latest,
        back: 0,
        lines: [],
        quote: last,
      }))
      await askAside($, question)
      return { text: 'Asked on the side, at the last line of the reply.' }
    }
    if (arg === 'fork') {
      const last = await latestAnswered($)
      if (last === undefined) return { text: 'No answered side question yet.' }
      await forkOut($, last)
      return { text: 'Forking the last side chat: its box says how it goes.' }
    }
    if (arg === 'clear') {
      await setNotes($, () => [])
      return { text: 'Removed every interjection box.' }
    }
    if (arg === 'keep' || arg === 'followup' || arg === 'follow-up') {
      const last = await latestAnswered($)
      if (last === undefined) return { text: 'No answered side question yet.' }
      if (arg === 'keep') {
        await keep($, last.id)
        return { text: 'Kept: the last side question and its answer go with your next message.' }
      }
      const main = (last.requestId === undefined ? undefined : seen.get(last.requestId)) ?? (await replyAt($, 0))
      await followUp($, last, main)
      return {}
    }
    const message = await start($)
    return message === undefined ? {} : { text: message }
  })

  // The band above the prompt: while a line is selected, a button to interject there.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const selection = await read($, picked)
    if (selection === null || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const theirs = await next(e)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Button key="interject-here" variant="primary" label="✎ Interject here" onPress={press => start($, press.surface)} />
          <Text dimColor>{clip(selection.text, Math.max(10, e.props.bodyColumns - 22))}</Text>
        </Box>
        {theirs}
      </Box>
    )
  })

  // The panel: pick a line, then type and choose (in the terminal; elsewhere the
  // form moves under the picked line).
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>Interject needs a text field: use it in the terminal, Desktop or VS Code.</Text>
    }
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const current = await read($, draft)
    const width = Math.max(20, e.props.bodyColumns - 2)

    if (current === null || current.inline === true) {
      return <Text dimColor>Select a line of a reply, then click ✎ Interject here or type /interject.</Text>
    }

    const elements = { Box, Text, Button, Input }
    return current.stage === 'pick' ? pickTree($, elements, current, width) : formTree($, elements, current, width)
  })

  // Each reply block: unchanged unless it holds a line with an interjection,
  // where a highlighted box is drawn right after that line. A box's answer
  // holds the boxes interjected on it, the same way. After a cut, the rest of
  // the reply (and of the answer cut in) is hidden. On Desktop and VS Code the
  // form being typed is drawn the same way, under its line.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = e.props.text
    seen.set(e.requestId, text)

    const all = await read($, notes)
    const top = all.filter(
      n => n.on === undefined && (n.requestId !== undefined ? n.requestId === e.requestId : text.includes(n.quote)),
    )
    const form = await read($, draft)
    const formHere = form !== null && form.inline === true && form.requestId === e.requestId ? form : null
    const formBox =
      formHere === null || e.surface === 'terminal' || e.surface === 'mobile'
        ? undefined
        : formHere.stage === 'pick'
          ? pickTree($, $.ui.resolve(e), formHere, 200)
          : formTree($, $.ui.resolve(e), formHere, 60)
    // Where the form goes: after its line here, or inside the answer it
    // interjects on. The list of lines (no line yet) goes at the end of the reply.
    const formEnd = (within: string, answerOf: string | undefined) =>
      formHere !== null && formBox !== undefined && formHere.on === answerOf ? endOfQuote(within, formHere.quote) : undefined
    if (top.length === 0 && formBox === undefined) return next(e)

    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const indent = e.surface === 'terminal' ? 2 : 0

    const cutLine = (rest: string, what: string) => {
      const lines = splitUnits(rest).length
      return <Text dimColor>{'✂ The rest of this ' + what + ' (' + lines + (lines === 1 ? ' line' : ' lines') + ') was cut.'}</Text>
    }

    // One box, with the boxes interjected on its answer drawn inside it.
    const drawNote = (n: InterjectNote, depth: number): { box: RenderElement; isCut: boolean } => {
      let isCut = n.mode === 'cut'
      const body: RenderElement[] = []
      if (n.status === 'answered' && n.answer !== undefined) {
        const inside = depth < MAX_DEPTH ? all.filter(m => m.on === n.id) : []
        let from = 0
        for (const { end, notes: here, form: hasForm } of fitTables(n.answer, withForm(anchorsIn(n.answer, inside), formEnd(n.answer, n.id)))) {
          const segment = pieceOf(n.answer, from, end)
          if (segment.trim() !== '') body.push(<Markdown text={segment} />)
          for (const m of here) {
            const drawn = drawNote(m, depth + 1)
            body.push(drawn.box)
            isCut = isCut || drawn.isCut
          }
          if (hasForm === true && formBox !== undefined && !isCut) body.push(formBox)
          from = end
          if (isCut) break
        }
        const rest = n.answer.slice(from).replace(/^\n+/, '')
        if (rest.trim() !== '') body.push(isCut ? cutLine(rest, 'answer') : <Markdown text={pieceOf(n.answer, from)} />)
      }

      const icon = n.mode === 'side' ? '? ' : n.mode === 'queue' ? '+ ' : '✂ '
      const box = (
        <Box flexDirection="column" minWidth={0} borderStyle="round" borderColor="warning" paddingX={1}>
          <Text color="warning" weight="semibold">
            {icon + n.question}
          </Text>
          {n.status === 'thinking' && (
            <Text dimColor>{n.agentId === undefined && n.outside !== true ? 'Thinking…' : 'Working on it on the side…'}</Text>
          )}
          {n.status === 'thinking' && (n.steps ?? []).map(step => <Text dimColor>{'· ' + step}</Text>)}
          {body}
          {n.status === 'failed' && <Text color="error">{n.answer ?? 'No answer'}</Text>}
          {n.status === 'queued' && <Text dimColor>Will be attached to your next message.</Text>}
          {n.status === 'sent' && <Text dimColor>Attached to your message.</Text>}
          {n.status === 'continuing' && <Text dimColor>Cut here. Claude continues from your interjection below.</Text>}
          {n.status === 'waiting' && <Text dimColor>Cut here. Press Enter to send your interjection and continue.</Text>}
          {n.keep === 'queued' && <Text dimColor>Kept: goes with your next message.</Text>}
          {n.keep === 'sent' && <Text dimColor>Kept: attached to your message.</Text>}
          {n.status === 'answered' && (n.steps ?? []).length > 0 && (
            <Text dimColor>{'Used tools: ' + (n.steps ?? []).map(step => step.split(' ')[0]).join(', ')}</Text>
          )}
          {n.noTools !== undefined && <Text dimColor>{n.noTools}</Text>}
          {n.forked !== undefined && <Text dimColor>{n.forked}</Text>}
          <Box flexDirection="row" flexWrap="wrap" gap={2}>
            {n.mode === 'side' && n.status === 'answered' && (
              <Button key={'follow-' + n.id} plain dimColor label="follow up" onPress={press => followUp($, n, text, press.surface)} />
            )}
            {n.mode === 'side' && n.status === 'answered' && n.keep === undefined && (
              <Button key={'keep-' + n.id} plain dimColor label="keep" onPress={() => keep($, n.id)} />
            )}
            {n.mode === 'side' && n.status === 'answered' && n.noTools !== undefined && n.forked === undefined && (
              <Button key={'tools-' + n.id} plain dimColor label="ask again with tools" onPress={() => withTools($, n, text)} />
            )}
            {n.mode === 'side' && n.status === 'answered' && n.forked === undefined && e.surface === 'desktop' && (
              <Button key={'fork-' + n.id} plain dimColor label="fork to session" onPress={() => forkOut($, n)} />
            )}
            <Button key={'dismiss-' + n.id} plain dimColor label="dismiss" onPress={() => dismiss($, n)} />
          </Box>
        </Box>
      )
      return { box, isCut }
    }

    const parts: RenderElement[] = []
    let from = 0
    let isCut = false
    for (const [i, { end, notes: here, form: hasForm }] of fitTables(text, withForm(anchorsIn(text, top), formEnd(text, undefined))).entries()) {
      const segment = pieceOf(text, from, end)
      if (i === 0) {
        // The engine draws the first part, so the reply keeps its own look.
        parts.push(await next({ ...e, props: { ...e.props, text: segment } }))
      } else if (segment.trim() !== '') {
        parts.push(
          <Box flexDirection="column" minWidth={0} paddingLeft={indent}>
            <Markdown text={segment} />
          </Box>,
        )
      }
      for (const n of here) {
        const drawn = drawNote(n, 1)
        parts.push(
          <Box flexDirection="column" minWidth={0} marginLeft={indent}>
            {drawn.box}
          </Box>,
        )
        isCut = isCut || drawn.isCut
      }
      if (hasForm === true && formBox !== undefined && !isCut) {
        parts.push(
          <Box flexDirection="column" marginLeft={indent}>
            {formBox}
          </Box>,
        )
      }
      from = end
      if (isCut) break
    }

    const rest = text.slice(from).replace(/^\n+/, '')
    if (rest.trim() !== '') {
      parts.push(
        <Box flexDirection="column" minWidth={0} paddingLeft={indent}>
          {isCut ? cutLine(rest, 'reply') : <Markdown text={pieceOf(text, from)} />}
        </Box>,
      )
    }
    // No minWidth here: the engine's own drawing of the first part is a child,
    // and Desktop refuses an engine node under a Box with one.
    return <Box flexDirection="column">{parts}</Box>
  })

  // The message a cut sends for the person: drawn as one short line.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const origin = e.props.origin
    if (e.props.isExpanded || origin.kind !== 'plugin' || origin.name !== 'interject' || !e.props.text.startsWith(MARK)) {
      return next(e)
    }
    const question = /^My interjection: (.*)$/m.exec(e.props.text)?.[1] ?? ''
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text color="warning">{'✂ Cut and continue: '}</Text>
        <Text>{question}</Text>
      </Box>
    )
  })

  // A cut made while Claude was writing: the part being written is stored
  // ending at the line, so Claude never reads what came after it. Narrowed to
  // Claude's replies, so a managed plugin that sends other rows straight on
  // past the user tier does not report this hook skipped on each of them.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    const cut = pendingCut
    if (cut === undefined || e.agentId !== undefined || e.message.role !== 'assistant') {
      return next(e)
    }
    const blocks = e.message.content
    const at = blocks.findIndex(
      b => b.type === 'text' && typeof b.text === 'string' && findUnit(splitUnits(b.text), cut.quote) >= 0,
    )
    const block = blocks[at]
    const blockText = block?.text
    if (block === undefined || typeof blockText !== 'string') return next(e)
    pendingCut = undefined
    const end = endOfQuote(blockText, cut.quote)
    const content = blocks.flatMap((b, i) => {
      if (i < at) return [b]
      if (i === at) return [{ ...b, text: blockText.slice(0, end) }]
      return b.type === 'text' ? [] : [b]
    })
    return next({ ...e, message: { ...e.message, content } })
  })

  // Add to next message, keep, and a cut waiting for Enter: attached to the
  // next prompt the person sends themselves.
  on('prompt.submit', async ($, e, next) => {
    // A side chat's agent finished: its notice stays out of the conversation,
    // as the side chat does; its answer is in its box.
    if (e.origin.kind === 'task-notification') {
      const ours = (await read($, notes)).filter(n => n.agentId !== undefined)
      if (ours.some(n => e.text.includes(n.agentId ?? '') || e.text.includes(sideDescription(n.question)))) {
        return { drop: 'An interject side chat finished: its answer is in its box.' }
      }
      return next(e)
    }
    // What the person sent: typed at the terminal (composer), from a phone
    // (bridge), or in the desktop app or VS Code, whose box is the host's (sdk).
    const typed = e.origin.kind === 'composer' || e.origin.kind === 'bridge' || e.origin.kind === 'sdk'
    if (e.isMeta === true || e.command !== undefined || !typed) return next(e)
    const list = await read($, notes)
    const queued = list.filter(n => n.mode === 'queue' && n.status === 'queued')
    const kept = list.filter(n => n.keep === 'queued')
    const waiting = list.filter(n => n.mode === 'cut' && n.status === 'waiting')
    if (queued.length + kept.length + waiting.length === 0) return next(e)

    const context = [
      ...(e.context ?? []),
      ...waiting.map(n => n.pending ?? ''),
      ...queued.map(n => queueContext(list, n)),
      ...kept.map(n => keptContext(list, n)),
    ].filter(c => c !== '')
    const result = await next({ ...e, context })
    if (result.drop === undefined) {
      const ids = new Set([...queued, ...kept, ...waiting].map(n => n.id))
      await setNotes($, all =>
        all.map((n): InterjectNote => {
          if (!ids.has(n.id)) return n
          if (n.mode === 'queue') return { ...n, status: 'sent' }
          if (n.mode === 'cut') return { ...n, status: 'continuing', pending: undefined }
          return { ...n, keep: 'sent' }
        }),
      )
    }
    return result
  })
}
