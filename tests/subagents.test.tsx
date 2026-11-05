import { expect, mock, test } from 'claude-code/testing'
import type { AgentInfo, AgentSpawnInput, On, SessionMessage, TurnUsage } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const pane = (agentId?: string, bodyColumns = 60) =>
  ({
    plugin: 'subagent-monitor',
    component: 'Pane',
    requestId: 'subagents',
    props: {
      title: 'Subagents',
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 30 },
      view: agentId === undefined ? {} : { agentId },
    },
  }) as const

const transcriptPane = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'subagent-monitor',
    component: 'Pane',
    requestId: 'subagent-transcript',
    surface,
    props: {
      title: 'Explore · transcript',
      isFocused: false,
      bodyColumns: 60,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  }) as const

const CONVERSATION: SessionMessage[] = [
  { role: 'user', text: 'Find the routes', toolUses: [] },
  {
    role: 'assistant',
    text: 'Looking around.',
    toolUses: [
      { tool_use_id: 't1', tool: 'Grep', input: { pattern: 'router' }, text: '3 matches' },
      {
        tool_use_id: 't2',
        tool: 'Read',
        input: { file_path: '/src/app.ts' },
        text: 'File not found',
        isError: true,
      },
      { tool_use_id: 't3', tool: 'Glob', input: { pattern: '**/*.ts' } },
    ],
  },
  { role: 'user', text: '', toolUses: [] },
  { role: 'assistant', text: 'Found **3** routes.', toolUses: [] },
]

const spawnInput = (over: Partial<AgentSpawnInput> = {}): AgentSpawnInput => ({
  tool_use_id: 'call-1',
  prompt: 'Find them',
  description: 'Find API endpoints',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
  ...over,
})

const usage = (input: number, output: number, cacheRead: number): TurnUsage => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: 0,
  model: 'claude-haiku-5-5',
})

const done = (id: string, status: AgentInfo['status'] = 'completed'): AgentInfo => ({
  id,
  description: 'Find API endpoints',
  type: 'Explore',
  status,
})

// The "engine" beneath the plugin: each hook here is its answer.
function engine(on: On, list: () => AgentInfo[] = () => []) {
  const toasts: string[] = []
  const views: { agentId?: string }[] = []
  const opened: string[] = []
  const closed: string[] = []
  let stepUsage: TurnUsage | null = usage(1000, 200, 8000)
  let conversation: SessionMessage[] | { deny: string } = CONVERSATION

  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    closed.push(e.id)

    return { value: undefined }
  })
  on('session.messages', () => ({ value: conversation }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.view', (_, e) => {
    views.push({ ...e })

    return { value: {} }
  })
  on('agent.list', () => ({ value: list() }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', (_, e) => ({
    model: 'claude-haiku-5-5',
    agentId: e.tool_use_id === 'call-2' ? 'a2' : 'a1',
  }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {} }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: stepUsage,
    }
  })

  return {
    toasts,
    views,
    opened,
    closed,
    setUsage: (next: TurnUsage | null) => {
      stepUsage = next
    },
    setConversation: (next: SessionMessage[] | { deny: string }) => {
      conversation = next
    },
  }
}

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}

// $.tool.call's overloads turn too deep for a literal argument.
async function callTool($: Engine, args: Readonly<Record<string, unknown>>): Promise<void> {
  await ($.tool.call as unknown as (input: unknown) => Promise<unknown>)(args)
}

async function step(
  $: Engine,
  agentId: string | undefined,
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max',
): Promise<void> {
  const stream = $.turn.step({
    turnId: 't1',
    index: 0,
    model: 'claude-haiku-5-5',
    messageCount: 3,
    agentId,
    effort,
  })
  for await (const _ of stream) {
    // The chunks just pass through.
  }
  await stream.result
}

test('a started agent shows as a card and the pane opens by itself', async ($, on) => {
  mock.clock(on, { now: 0 })
  const world = engine(on)
  await start($)
  await $.agent.spawn(spawnInput())

  expect(world.opened).toContain('subagents')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane(), surface })
    expect((await ui.find({ key: 'a1' }))?.text).toMatch(/Explore/)
    expect(await ui.find({ type: 'Text', text: /Find API endpoints/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /0:00/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /● running/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /haiku-5-5/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 active/ })).toBeDefined()
    await ui.unmount()
  }
})

test('an SVG creature on desktop, a colored face on the terminal', async ($, on) => {
  mock.clock(on, { now: 0 })
  engine(on)
  await start($)
  await $.agent.spawn(spawnInput())

  const desktop = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await desktop.find({ type: 'Svg' })).toBeDefined()
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect(await terminal.find({ type: 'Text', text: /\((•|-)‿(•|-)\)/ })).toBeDefined()
  await terminal.unmount()
})

test("tokens, model and effort come from the agent's own requests", async ($, on) => {
  mock.clock(on, { now: 0 })
  const world = engine(on)
  await start($)
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'high')
  world.setUsage(usage(500000, 0, 0))
  await step($, undefined, 'max')

  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  const meta = await ui.find({ type: 'Text', text: /▰/ })
  expect(meta?.text).toMatch(/haiku-5-5 · ▰▰▰▱▱ high · 9\.2k tok/)
  expect(await ui.find({ type: 'Text', text: /Σ 9\.2k tok/ })).toBeDefined()
  await ui.unmount()
})

test('a count just below one million rounds up to 1.0M, not 1000.0k', async ($, on) => {
  mock.clock(on, { now: 0 })
  const world = engine(on)
  await start($)
  await $.agent.spawn(spawnInput())

  world.setUsage(usage(999_949, 0, 0))
  await step($, 'a1')
  let ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Σ 999\.9k tok/ })).toBeDefined()
  await ui.unmount()

  world.setUsage(usage(999_950, 0, 0))
  await step($, 'a1')
  ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /haiku-5-5/ }))?.text).toMatch(/1\.0M tok/)
  expect(await ui.find({ type: 'Text', text: /Σ 1\.0M tok/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1000\.0k/ })).toBeUndefined()
  await ui.unmount()
})

test('the live activity line and the tool count show', async ($, on) => {
  mock.clock(on, { now: 0 })
  engine(on)
  await start($)
  await $.agent.spawn(spawnInput())
  await callTool($, { tool: 'Grep', pattern: 'TODO', agentId: 'a1' })
  await callTool($, { tool: 'Read', file_path: '/src/app/register.tsx', agentId: 'a1' })
  await callTool($, { tool: 'Grep', pattern: 'main chat' })

  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /↳/ }))?.text).toMatch(/↳ Read · register\.tsx/)
  expect(await ui.find({ type: 'Text', text: /2 tools/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /activity/ })).toBeDefined()
  await ui.unmount()
})

test('the layout follows the pane width', async ($, on) => {
  mock.clock(on, { now: 0 })
  engine(on)
  await start($)
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'high')

  for (const surface of ['terminal', 'desktop'] as const) {
    // Compact rows: no description line.
    const narrow = await $.ui.mount({ ...pane(undefined, 30), surface })
    expect(await narrow.find({ key: 'a1' })).toBeDefined()
    expect(await narrow.find({ type: 'Text', text: /Find API endpoints/ })).toBeUndefined()
    await narrow.unmount()

    // A snug card: model and cost on two lines.
    const snug = await $.ui.mount({ ...pane(undefined, 44), surface })
    expect((await snug.find({ type: 'Text', text: /haiku-5-5/ }))?.text).not.toMatch(/tok/)
    expect(await snug.find({ type: 'Text', text: /^9\.2k tok$/ })).toBeDefined()
    await snug.unmount()

    // A regular card: one meta line.
    const regular = await $.ui.mount({ ...pane(undefined, 70), surface })
    expect((await regular.find({ type: 'Text', text: /haiku-5-5/ }))?.text).toMatch(/9\.2k tok/)
    await regular.unmount()

    // A grid: the card still shows its description.
    const wide = await $.ui.mount({ ...pane(undefined, 150), surface })
    expect(await wide.find({ type: 'Text', text: /Find API endpoints/ })).toBeDefined()
    await wide.unmount()
  }
})

test('a finished agent raises a toast', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const world = engine(on)
  await start($)
  await $.agent.spawn(spawnInput())
  await clock.advance(75_000)
  await $.turn.complete({
    answer: 'Found',
    durationMs: 75_000,
    isAborted: false,
    turnId: 't1',
    agentId: 'a1',
    reason: 'answer',
  })

  expect(world.toasts[0]).toMatch(/✓ Explore finished · 1:15 — Find API endpoints/)

  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /✓ done/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1:15/ })).toBeDefined()
  await ui.unmount()
})

test('a toast fires even when only the agent list says it finished', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  let list: AgentInfo[] = []
  const world = engine(on, () => list)
  await start($)
  await $.agent.spawn(spawnInput())
  await clock.advance(21_000)
  list = [done('a1')]
  await clock.advance(1000)

  expect(world.toasts).toHaveLength(1)
  expect(world.toasts[0]).toMatch(/✓ Explore finished · 0:22 — Find API endpoints/)
})

test('the toast fires once when both paths see the end', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  let list: AgentInfo[] = []
  const world = engine(on, () => list)
  await start($)
  await $.agent.spawn(spawnInput())
  await $.turn.complete({
    answer: 'Found',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    agentId: 'a1',
    reason: 'answer',
  })
  list = [done('a1')]
  await clock.advance(3000)

  expect(world.toasts).toHaveLength(1)
})

test('agents that finish together share one toast', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  let list: AgentInfo[] = []
  const world = engine(on, () => list)
  await start($)
  await $.agent.spawn(spawnInput())
  await $.agent.spawn(spawnInput({ tool_use_id: 'call-2' }))
  list = [done('a1'), done('a2', 'failed')]
  await clock.advance(1000)

  expect(world.toasts).toHaveLength(1)
  expect(world.toasts[0]).toMatch(/^2 subagents finished: ✓ Explore 0:01, ✗ Explore 0:01$/)
})

test('the status follows $.agent.list()', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  let list: AgentInfo[] = []
  engine(on, () => list)
  await start($)
  await $.agent.spawn(spawnInput())
  list = [done('a1', 'failed')]
  await clock.advance(1000)

  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /✗ failed/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0:01/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✗ 1/ })).toBeDefined()
  await ui.unmount()
})

test('in the terminal a press opens the transcript, a second goes back to main', async ($, on) => {
  mock.clock(on, { now: 0 })
  const world = engine(on)
  await start($)
  await $.agent.spawn(spawnInput())

  const main = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect((await main.find({ key: 'a1' }))?.text).toMatch(/↗/)
  await main.press({ key: 'a1' })
  expect(world.views[0]).toEqual({ agentId: 'a1' })
  await main.unmount()

  const viewing = await $.ui.mount({ ...pane('a1'), surface: 'terminal' })
  expect(await viewing.find({ key: 'main' })).toBeDefined()
  await viewing.press({ key: 'a1' })
  expect(world.views[1]).toEqual({})
  await viewing.unmount()
})

test('on graphical surfaces a press opens and closes the details in place', async ($, on) => {
  mock.clock(on, { now: 0 })
  const world = engine(on)
  await start($)
  await $.agent.spawn(spawnInput())
  await step($, 'a1', 'high')

  for (const surface of ['desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...pane(), surface })
    expect((await ui.find({ key: 'a1' }))?.text).toMatch(/▸/)
    expect(await ui.find({ type: 'Text', text: /Agent id/ })).toBeUndefined()

    await ui.press({ key: 'a1' })
    expect((await ui.find({ key: 'a1' }))?.text).toMatch(/▾/)
    expect(await ui.find({ type: 'Text', text: /Agent id\s+a1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Model\s+claude-haiku-5-5/ })).toBeDefined()

    await ui.press({ key: 'a1' })
    expect(await ui.find({ type: 'Text', text: /Agent id/ })).toBeUndefined()
    await ui.unmount()
  }

  expect(world.views).toHaveLength(0)
})

test("the details show the start of the agent's answer once it finishes", async ($, on) => {
  mock.clock(on, { now: 0 })
  engine(on)
  await start($)
  await $.agent.spawn(spawnInput())
  await $.turn.complete({
    answer: 'Found 12 endpoints under src/routes.',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    agentId: 'a1',
    reason: 'answer',
  })

  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  await ui.press({ key: 'a1' })
  expect(await ui.find({ type: 'Text', text: /Found 12 endpoints under src\/routes\./ })).toBeDefined()
  await ui.unmount()
})

// Opens a1's details and presses its transcript button on the desktop.
async function openTranscriptOfA1($: Engine): Promise<void> {
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  await ui.press({ key: 'a1' })
  await ui.press({ key: 'transcript-a1' })
  await ui.unmount()
}

test("the details' button opens the transcript pane", async ($, on) => {
  mock.clock(on, { now: 0 })
  const world = engine(on)
  await start($)
  await $.agent.spawn(spawnInput())
  await openTranscriptOfA1($)

  expect(world.opened).toContain('subagent-transcript')

  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect((await ui.find({ key: 'transcript-a1' }))?.text).toMatch(/Transcript open/)
  await ui.unmount()
})

test("the transcript pane draws the agent's conversation", async ($, on) => {
  mock.clock(on, { now: 0 })
  engine(on)
  await start($)
  await $.agent.spawn(spawnInput())
  await openTranscriptOfA1($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(transcriptPane(surface))
    expect(await ui.find({ type: 'Text', text: /^Explore/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /Find the routes/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /Looking around\./ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /✓ Grep · router/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /✗ Read · app\.ts — File not found/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /◌ Glob · \*\*\/\*\.ts/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /Found \*\*3\*\* routes\./ })).toBeDefined()
    await ui.unmount()
  }
})

test("a transcript that can't be read says why", async ($, on) => {
  mock.clock(on, { now: 0 })
  const world = engine(on)
  await start($)
  await $.agent.spawn(spawnInput())
  await openTranscriptOfA1($)
  world.setConversation({ deny: 'no agent a1 in this session' })

  const ui = await $.ui.mount(transcriptPane('desktop'))
  expect(
    await ui.find({ type: 'Text', text: /Couldn't read this transcript: no agent a1 in this session/ }),
  ).toBeDefined()
  await ui.unmount()
})

test('Close shuts the transcript pane', async ($, on) => {
  mock.clock(on, { now: 0 })
  const world = engine(on)
  await start($)
  await $.agent.spawn(spawnInput())
  await openTranscriptOfA1($)

  const ui = await $.ui.mount(transcriptPane('desktop'))
  await ui.press({ key: 'close' })
  await ui.unmount()

  expect(world.closed).toContain('subagent-transcript')
  const after = await $.ui.mount(transcriptPane('desktop'))
  expect(await after.find({ type: 'Text', text: /press Open transcript/ })).toBeDefined()
  await after.unmount()
})

test('a nested agent follows its parent', async ($, on) => {
  mock.clock(on, { now: 0 })
  engine(on)
  await start($)
  await $.agent.spawn(spawnInput())
  await $.agent.spawn(
    spawnInput({
      tool_use_id: 'call-2',
      description: 'Check the tests',
      subagentType: 'general-purpose',
      parentAgentId: 'a1',
    }),
  )

  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons.map(one => one.key)).toEqual(['a1', 'a2'])
  await ui.unmount()
})

// A small model of how a surface lays a drawn tree out across, in cells: the
// flexbox rules that decide whether a card keeps its column's width. A flex
// item in a row can't shrink below its content's min-content (a nowrap Text's
// whole length) unless it has minWidth 0 or overflow hidden; a column
// stretches its children to its width; overflow hidden clips what is beneath.
type Drawn = {
  type: string
  key: string | undefined
  props: Record<string, unknown>
  children: unknown[]
}

type Laid = {
  node: Drawn
  x: number
  width: number
  // The right edge of the nearest overflow-hidden ancestor, if any.
  clip: number
  textLength: number
  // The keys of the Boxes it sits in, outermost first.
  within: string[]
}

const STEP: Record<string, number> = { xs: 1, sm: 1, md: 2 }

const isDrawn = (value: unknown): value is Drawn =>
  typeof value === 'object' && value !== null && 'type' in value

// The drawn tree with every element's props and children filled in.
function norm(value: unknown): unknown {
  if (!isDrawn(value)) return value
  const props = (value.props ?? {}) as Record<string, unknown>
  const key = value.key ?? (typeof props.key === 'string' ? props.key : undefined)

  return { type: value.type, key, props, children: (value.children ?? []).map(norm) }
}

function cells(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') return STEP[value] ?? 0

  return 0
}

function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (!isDrawn(node)) return ''

  return node.children.map(textOf).join('')
}

const length = (text: string): number => [...text].length

function edges(node: Drawn): { left: number; right: number } {
  const p = node.props
  const border = p.borderStyle !== undefined ? 1 : 0
  const left = cells(p.paddingLeft ?? p.paddingX ?? p.padding) + border
  const right = cells(p.paddingRight ?? p.paddingX ?? p.padding) + border

  return { left, right }
}

const margin = (node: Drawn): number =>
  cells(node.props.marginLeft ?? node.props.marginX ?? node.props.margin)

const direction = (node: Drawn): string =>
  node.type === 'Box' ? String(node.props.flexDirection ?? 'row') : 'row'

const gapOf = (node: Drawn): number =>
  cells(
    direction(node).startsWith('row')
      ? (node.props.columnGap ?? node.props.gap)
      : (node.props.rowGap ?? node.props.gap),
  )

// Widest it would be with room to spare.
function maxContent(node: unknown, surface: string): number {
  if (typeof node === 'string') return length(node)
  if (!isDrawn(node)) return 0
  if (node.type === 'Svg') {
    const px = cells(node.props.width)

    return surface === 'terminal' ? px : Math.ceil(px / 8)
  }
  if (node.type !== 'Box') {
    const extra = node.type === 'Button' && node.props.plain !== true ? 4 : 0

    return length(textOf(node)) + extra
  }
  const { left, right } = edges(node)
  const kids = node.children.filter(isDrawn)
  const sizes = kids.map(kid =>
    kid.type === 'Box' && typeof kid.props.width === 'number' ? kid.props.width : maxContent(kid, surface) + margin(kid),
  )
  const inner = direction(node).startsWith('row')
    ? sizes.reduce((a, b) => a + b, 0) + gapOf(node) * Math.max(0, kids.length - 1)
    : Math.max(0, ...sizes)

  return left + right + inner
}

// Narrowest it can be: a nowrap Text keeps its whole length.
function minContent(node: unknown, surface: string): number {
  if (typeof node === 'string') return length(node)
  if (!isDrawn(node)) return 0
  if (node.type === 'Text' && node.props.wrap === 'wrap') {
    return Math.max(0, ...textOf(node).split(/\s+/).map(length))
  }
  if (node.type !== 'Box') return maxContent(node, surface)
  const { left, right } = edges(node)
  const kids = node.children.filter(isDrawn)
  const sizes = kids.map(kid =>
    kid.type === 'Box' && typeof kid.props.width === 'number' ? kid.props.width : minContent(kid, surface) + margin(kid),
  )
  const inner = direction(node).startsWith('row')
    ? sizes.reduce((a, b) => a + b, 0) + gapOf(node) * Math.max(0, kids.length - 1)
    : Math.max(0, ...sizes)

  return left + right + inner
}

// The least a flex item in a row shrinks to (its automatic minimum size).
const floorOf = (node: Drawn, surface: string): number =>
  node.props.minWidth === 0 || node.props.overflow === 'hidden'
    ? 0
    : minContent(node, surface)

function layout(
  node: Drawn,
  x: number,
  width: number,
  clip: number,
  surface: string,
  out: Laid[],
  within: string[] = [],
): void {
  out.push({ node, x, width, clip, textLength: length(textOf(node)), within })
  if (node.type !== 'Box') return
  const path = node.key !== undefined ? [...within, node.key] : within

  const { left, right } = edges(node)
  const innerX = x + left
  const inner = Math.max(0, width - left - right)
  const childClip = node.props.overflow === 'hidden' ? Math.min(clip, x + width) : clip
  const kids = node.children.filter(isDrawn)
  // A Box's width is in cells; an Svg's is in pixels, measured as content.
  const percent = (kid: Drawn): number | undefined => {
    if (kid.type !== 'Box') return undefined
    const w = kid.props.width
    if (typeof w === 'number') return w
    if (typeof w === 'string' && w.endsWith('%')) return Math.floor((inner * parseFloat(w)) / 100)

    return undefined
  }

  if (!direction(node).startsWith('row')) {
    for (const kid of kids) {
      const m = margin(kid)
      layout(kid, innerX + m, percent(kid) ?? inner - m, childClip, surface, out, path)
    }

    return
  }

  if (node.props.flexWrap === 'wrap') {
    // Each child at its own width, wrapping onto new lines.
    let lineX = 0
    for (const kid of kids) {
      const w = percent(kid) ?? maxContent(kid, surface)
      if (lineX > 0 && lineX + w > inner) lineX = 0
      layout(kid, innerX + lineX, w, childClip, surface, out, path)
      lineX += w
    }

    return
  }

  // One flex line: start each item at its content, then grow or shrink.
  const gap = gapOf(node)
  const fixed = kids.map(kid => percent(kid))
  const sizes = kids.map((kid, i) => fixed[i] ?? maxContent(kid, surface))
  const room = inner - gap * Math.max(0, kids.length - 1)
  let free = room - sizes.reduce((a, b) => a + b, 0)
  if (free > 0) {
    const growers = kids.filter((kid, i) => fixed[i] === undefined && cells(kid.props.flexGrow) > 0)
    for (const kid of growers) {
      const i = kids.indexOf(kid)
      sizes[i] = (sizes[i] ?? 0) + Math.floor(free / growers.length)
    }
  }
  for (let pass = 0; free < 0 && pass < kids.length; pass++) {
    const open = kids.filter(
      (kid, i) =>
        fixed[i] === undefined &&
        kid.props.flexShrink !== 0 &&
        (sizes[i] ?? 0) > floorOf(kid, surface),
    )
    if (open.length === 0) break
    const share = Math.ceil(-free / open.length)
    for (const kid of open) {
      const i = kids.indexOf(kid)
      const before = sizes[i] ?? 0
      const after = Math.max(floorOf(kid, surface), before - share)
      sizes[i] = after
      free += before - after
    }
  }
  let at = innerX
  kids.forEach((kid, i) => {
    const m = margin(kid)
    layout(kid, at + m, sizes[i] ?? 0, childClip, surface, out, path)
    at += m + (sizes[i] ?? 0) + gap
  })
}

test('a running card with a long command keeps its column next to a done card', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  engine(on)
  await start($)
  await $.agent.spawn(
    spawnInput({ description: 'Review free AI provider change and every file it touched along the way' }),
  )
  await callTool($, {
    tool: 'Bash',
    command:
      'cd "C:/Users/user/Desktop/newsite/.claude/worktrees/agent-review-free-ai-provider" && git diff --stat main...HEAD',
    agentId: 'a1',
  })
  await $.agent.spawn(spawnInput({ tool_use_id: 'call-2', description: 'Implement free AI provider chain' }))
  await clock.advance(5000)
  await $.turn.complete({
    answer: 'Done',
    durationMs: 5000,
    isAborted: false,
    turnId: 't2',
    agentId: 'a2',
    reason: 'answer',
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    for (const columns of [30, 44, 60, 96, 110, 150, 200]) {
      const ui = await $.ui.mount({ ...pane(undefined, columns), surface })
      const root = await ui.find({ type: 'Box' })
      expect(root).toBeDefined()
      const laid: Laid[] = []
      layout(norm(root) as Drawn, 0, columns, columns, surface, laid)

      const where = `${surface} at ${columns} columns`
      const cards = laid.filter(one => one.node.key?.startsWith('card-') === true)
      const cellsOf = laid.filter(one => one.node.key?.startsWith('cell-') === true)
      const isGrid = columns >= 96
      expect({ where, cards: cards.length }).toEqual({ where, cards: columns < 36 ? 0 : 2 })
      expect({ where, cells: cellsOf.length }).toEqual({ where, cells: isGrid ? 2 : 0 })

      for (const card of cards) {
        const id = card.node.key
        const cell = cellsOf.find(one => one.node.key === id?.replace('card-', 'cell-'))
        // Its column: the grid cell less its gutter, or the pane itself.
        const limit = cell !== undefined ? cell.x + cell.width - edges(cell.node).right : columns
        expect({ where, id, right: card.x + card.width }).toEqual({
          where,
          id,
          right: Math.min(card.x + card.width, limit),
        })

        // Every Text in the card ends inside it on its own, not cut by the
        // card's edge, and one longer than its room truncates or wraps.
        const texts = laid.filter(
          one => one.node.type === 'Text' && id !== undefined && one.within.includes(id),
        )
        expect({ where, id, hasTexts: texts.length > 2 }).toEqual({ where, id, hasTexts: true })
        for (const text of texts) {
          const shown = textOf(text.node)
          const fits = text.x + text.width <= card.x + card.width - edges(card.node).right
          const isCut = text.textLength > text.width
          const wrap = text.node.props.wrap
          const truncates = !isCut || wrap === 'truncate-end' || wrap === 'wrap'
          expect({ where, shown, fits, truncates }).toEqual({ where, shown, fits: true, truncates: true })
        }
      }

      // No two cards on a line overlap.
      const sorted = [...cards].sort((a, b) => a.x - b.x)
      for (let i = 1; i < sorted.length; i++) {
        const before = sorted[i - 1]
        const after = sorted[i]
        if (before === undefined || after === undefined || cellsOf.length === 0) continue
        expect({ where, overlap: before.x + before.width > after.x }).toEqual({ where, overlap: false })
      }
      await ui.unmount()
    }
  }
})

test('an empty pane shows a sleeping creature and a hint', async ($, on) => {
  on('state.get', () => ({
    value: { value: [{ id: 'old' }], version: 1 },
  }))
  mock.clock(on, { now: 0 })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane(), surface })
    expect(await ui.find({ type: 'Text', text: /No subagents yet/ })).toBeDefined()
    await ui.unmount()
  }
})
