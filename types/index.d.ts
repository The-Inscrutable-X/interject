/** One interjection the person made at a line of a reply, or of a side answer. */
export type InterjectNote = {
  id: string
  /** The transcript row (one block of a reply) the box is drawn in, when known. */
  requestId?: string
  /** The line the person picked: a source line of the reply or answer, or what they selected. */
  quote: string
  /** The text the person selected with the mouse, as drawn: absent when they picked the line from the list. */
  selected?: string
  /** What the person typed. */
  question: string
  /**
   * `side`: answered at the line, never added to the conversation.
   * `queue`: attached to the next message.
   * `cut`: the reply after the line is withdrawn and Claude continues from the interjection.
   */
  mode: 'side' | 'queue' | 'cut'
  /**
   * side: thinking, answered, failed. queue: queued, then sent.
   * cut: continuing (sent), or waiting for the person to press Enter.
   */
  status: 'thinking' | 'answered' | 'failed' | 'queued' | 'sent' | 'continuing' | 'waiting'
  /** The side chat's answer, or why there is none. */
  answer?: string
  /** Interjects on a line of this note's answer: drawn inside that note's box. */
  on?: string
  /** Follows up on this side question, at the same line. */
  parent?: string
  /** A side answer the person chose to keep: attached to the next message, then sent. */
  keep?: 'queued' | 'sent'
  /** Older boxes only: their own copy of what was sent. Newer boxes name the send instead (sentId). */
  sent?: string
  /** The send this box went with: what was sent is saved once for all its boxes, apart from them. */
  sentId?: string
  /** A cut waiting for Enter: the instructions that go with the person's message. */
  pending?: string
  /** A side chat's agent: a fork of the conversation that can use tools, as `$.agent.spawn` answered it. */
  agentId?: string
  /** The side chat runs as a Claude Code process of its own: the session would not start its agent. */
  outside?: true
  /** What the side chat's agent has done so far, oldest first: one short line per tool call, the last six. */
  steps?: string[]
  /** Set when the side chat's agent was not let start and one plain completion answered: what its box says. */
  noTools?: string
  /** Set once the side chat was forked into a session of its own: what its box says. */
  forked?: string
}

/** The interjection being written: in the panel, or in a form under its line. */
export type InterjectDraft = {
  /** `pick`: choosing a line from a list. `type`: typing the question. */
  stage: 'pick' | 'type'
  /**
   * Drawn in a reply row (Desktop, VS Code), not in the panel: the form under
   * its line, or the list of lines at the end of the reply.
   */
  inline?: boolean
  requestId?: string
  /** The text the line comes from: the reply, or a side answer. */
  reply: string
  /** The reply the whole chain starts from. */
  main: string
  /** While picking: how many replies back from the latest (0 is the latest). */
  back: number
  /** The lines offered while picking. */
  lines: string[]
  quote: string
  /** The text the person selected with the mouse, as drawn: absent when they picked the line from the list. */
  selected?: string
  /** A line of this note's answer. */
  on?: string
  /** A follow-up on this side question. */
  parent?: string
}

/**
 * What went with one message the person sent (or a cut): the text itself is
 * saved apart, in <session>/sent/<id>.txt.
 */
export type InterjectSend = {
  /** "<session id>/<id>": the session whose folder holds the text. */
  id: string
  /** How many boxes went with the message. */
  boxes: number
  /** The first row of Claude's answer to it, which shows the 📎 line. */
  row?: string
  /** A cut's message: its instructions went with it. */
  cut?: true
}

/** What the person has selected with the mouse, while it is in a reply. */
export type InterjectPicked = { text: string; requestId?: string }

declare module 'claude-code' {
  interface PluginState {
    interject: {
      notes: Shaped<InterjectNote[]>
      draft: Shaped<InterjectDraft | null>
      picked: InterjectPicked | null
      preview: string | null
      full: string[]
      sends: InterjectSend[]
    }
  }
}
