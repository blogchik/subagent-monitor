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
