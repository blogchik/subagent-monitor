import { atom, read, update } from 'claude-code'
import type {
  AgentInfo,
  Color,
  EngineInterface,
  Register,
  Space,
  TurnUsage,
} from 'claude-code'

import type { AgentRow, AgentRowStatus } from '../types'
import { creatureFace, creatureSvg, identityColor, spinnerFrame } from './creature'
import type { Mood } from './creature'

const PANE = 'subagents'
const TITLE = 'Subagents'
const MAX_ROWS = 50
const TICK_MS = 1000
const TOAST_MS = 8000
const PULSE_KEEP = 400
const ANSWER_KEEP = 600
const SPARK_BUCKET_MS = 10_000
// A finished agent stays animated this long (hop, sparkle), then turns into a
// light static picture.
const FRESH_MS = 15_000

// Pane width breakpoints, in cells.
const SNUG_FROM = 36
const REGULAR_FROM = 56
const GRID_FROM = 96
const GRID_CELL = 48

// Panel colors: blue while active, purple once done.
const ACTIVE: Color = '#378ADD'
const ACTIVE_SOFT: Color = '#85B7EB'
const DONE: Color = '#7F77DD'
const VIEWED: Color = '#D4537E'

// Change the tag when a row's fields change: a value an earlier version
// stored outlives a reload, and the tag declines it.
const agents = atom({ plugin: 'subagent-monitor', key: 'agents' } as const, [], {
  shape: 'agents-2',
})
const pulses = atom({ plugin: 'subagent-monitor', key: 'pulses' } as const, [])
const expanded = atom({ plugin: 'subagent-monitor', key: 'expanded' } as const, [])
const tick = atom({ plugin: 'subagent-monitor', key: 'tick' } as const, 0)
const isClosedByPerson = atom(
  { plugin: 'subagent-monitor', key: 'isClosedByPerson' } as const,
  false,
)

const LABEL: Record<AgentRowStatus, string> = {
  pending: 'pending',
  running: 'running',
  waiting: 'waiting',
  idle: 'idle',
  completed: 'done',
  failed: 'failed',
  killed: 'stopped',
}

const MARK: Record<AgentRowStatus, string> = {
  pending: '○',
  running: '●',
  waiting: '◐',
  idle: '◌',
  completed: '✓',
  failed: '✗',
  killed: '■',
}

const VERB: Partial<Record<AgentRowStatus, string>> = {
  completed: 'finished',
  killed: 'was stopped',
  failed: 'failed',
}

const COLOR: Partial<Record<AgentRowStatus, Color>> = {
  pending: ACTIVE_SOFT,
  running: ACTIVE,
  waiting: ACTIVE_SOFT,
  completed: DONE,
  failed: 'error',
  killed: 'warning',
}

const MOOD: Record<AgentRowStatus, Mood> = {
  pending: 'waiting',
  running: 'running',
  waiting: 'waiting',
  idle: 'idle',
  completed: 'completed',
  failed: 'failed',
  killed: 'stopped',
}

const EFFORT_LEVEL: Readonly<Record<string, number>> = {
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
}

const SPARK_BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

type $ = EngineInterface

const isActive = (status: AgentRowStatus): boolean =>
  status === 'pending' || status === 'running' || status === 'waiting'

const isEnded = (status: AgentRowStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'killed'

const plural = (count: number, word: string): string =>
  `${count} ${count === 1 ? word : `${word}s`}`

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M tok`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k tok`

  return `${count} tok`
}

function shortModel(model: string | undefined): string | undefined {
  if (model === undefined || model === '') return undefined

  return model
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/\[[^\]]*\]$/, '')
}

function effortText(effort: string | undefined): string | undefined {
  if (effort === undefined) return undefined
  const level = EFFORT_LEVEL[effort]
  if (level === undefined) return `effort ${effort}`

  return `${'▰'.repeat(level)}${'▱'.repeat(5 - level)} ${effort}`
}

// Like the "… tokens" in Claude Code's agent result: the latest request's context.
const contextTokens = (usage: TurnUsage): number =>
  usage.input_tokens +
  usage.output_tokens +
  usage.cache_read_input_tokens +
  usage.cache_creation_input_tokens

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(part => part !== '')

  return parts[parts.length - 1] ?? path
}

function clip(text: string, max = 60): string {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function clipAnswer(answer: string): string | undefined {
  const text = answer.trim()
  if (text === '') return undefined

  return text.length > ANSWER_KEEP ? `${text.slice(0, ANSWER_KEEP - 1)}…` : text
}

function clockTime(at: number): string {
  try {
    return new Date(at).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return new Date(at).toISOString().slice(11, 19)
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

// A short activity line from a tool call: "Grep · TODO", "Read · register.tsx".
function describeTool(tool: string, args: Readonly<Record<string, unknown>>): string {
  const text = (key: string): string | undefined => {
    const value = args[key]

    return typeof value === 'string' && value !== '' ? value : undefined
  }
  const name = tool.startsWith('mcp__')
    ? tool.split('__').slice(2).join('__') || tool
    : tool
  const filePath = text('file_path') ?? text('notebook_path')
  const url = text('url')
  const path = text('path')
  const detail =
    (filePath !== undefined ? basename(filePath) : undefined) ??
    text('pattern') ??
    text('command') ??
    text('query') ??
    (url !== undefined ? hostOf(url) : undefined) ??
    text('description') ??
    (path !== undefined ? basename(path) : undefined) ??
    text('skill')

  return detail === undefined ? name : `${name} · ${clip(detail)}`
}

// Drops the oldest finished rows first and never an active one.
function trim(rows: AgentRow[]): AgentRow[] {
  let extra = rows.length - MAX_ROWS
  if (extra <= 0) return rows

  return rows.filter(row => {
    if (extra > 0 && !isActive(row.status)) {
      extra -= 1

      return false
    }

    return true
  })
}

function upsert(rows: readonly AgentRow[], row: AgentRow): AgentRow[] {
  const old = rows.find(one => one.id === row.id)
  if (old === undefined) return trim([...rows, row])

  // A resumed agent keeps its counters and starts its clock again.
  return rows.map(one =>
    one.id === row.id
      ? { ...old, ...row, tokens: old.tokens, toolCount: old.toolCount }
      : one,
  )
}

function patch(
  rows: readonly AgentRow[],
  id: string,
  change: (row: AgentRow) => AgentRow,
): AgentRow[] {
  return rows.map(row => (row.id === id ? change(row) : row))
}

// $.agent.list() holds the true status. It also brings in active agents that
// started before the mod loaded.
function mergeList(
  rows: readonly AgentRow[],
  list: readonly AgentInfo[],
  now: number,
): AgentRow[] {
  const unseen = new Map(list.map(info => [info.id, info]))
  const merged = rows.map(row => {
    const info = unseen.get(row.id)
    if (info === undefined) return row
    unseen.delete(row.id)
    if (info.status === row.status) return row

    return {
      ...row,
      status: info.status,
      endedAt: isEnded(info.status) ? (row.endedAt ?? now) : undefined,
    }
  })

  for (const info of unseen.values()) {
    if (isEnded(info.status)) continue
    merged.push({
      id: info.id,
      type: info.type,
      description: info.description,
      parentId: info.parentId,
      isTeammate: info.teammateId !== undefined ? true : undefined,
      status: info.status,
      startedAt: now,
      tokens: 0,
      toolCount: 0,
    })
  }

  return trim(merged)
}

// Keeps two paths (turn.complete and the sync) from announcing one agent
// twice: no await sits between the check and the mark.
const notified = new Set<string>()

const shouldNotify = (row: AgentRow): boolean =>
  isEnded(row.status) &&
  row.isNotified !== true &&
  row.isTeammate !== true &&
  row.isWorkflow !== true &&
  !notified.has(row.id)

function finishText(rows: readonly AgentRow[]): string {
  const elapsed = (row: AgentRow): string =>
    formatElapsed((row.endedAt ?? row.startedAt) - row.startedAt)
  const [only] = rows
  if (rows.length === 1 && only !== undefined) {
    const cost = only.tokens > 0 ? ` · ${formatTokens(only.tokens)}` : ''

    return `${MARK[only.status]} ${only.type} ${VERB[only.status] ?? LABEL[only.status]} · ${elapsed(only)}${cost} — ${only.description}`
  }

  return `${rows.length} subagents finished: ${rows
    .map(row => `${MARK[row.status]} ${row.type} ${elapsed(row)}`)
    .join(', ')}`
}

async function notifyFinished($: $): Promise<void> {
  const due = (await read($, agents)).filter(shouldNotify)
  if (due.length === 0) return
  for (const row of due) notified.add(row.id)

  const ids = new Set(due.map(row => row.id))
  await update($, agents, rows =>
    rows.map(row => (ids.has(row.id) ? { ...row, isNotified: true } : row)),
  )
  $.ui.toast(finishText(due), { timeoutMs: TOAST_MS })
}

async function sync($: $): Promise<void> {
  const list = await $.agent.list()
  const now = await $.clock.now()
  const before = await read($, agents)
  const after = mergeList(before, list, now)
  if (JSON.stringify(after) === JSON.stringify(before)) return

  await update($, agents, rows => mergeList(rows, list, now))
  await notifyFinished($)
}

async function autoOpen($: $): Promise<void> {
  if (await read($, isClosedByPerson)) return
  await $.ui.open({ id: PANE, title: TITLE })
}

// A module variable: it starts over on a reload, which is fine here.
let isSyncing = false

async function onTick($: $): Promise<void> {
  if (isSyncing) return
  isSyncing = true
  try {
    const rows = await read($, agents)
    if (!rows.some(row => isActive(row.status))) return
    await sync($)
    await update($, tick, count => count + 1)
  } finally {
    isSyncing = false
  }
}

// Graphical surfaces have no main view to switch, so a press opens the
// card's details in place instead.
async function toggleDetails($: $, id: string): Promise<void> {
  await update($, expanded, list =>
    list.includes(id)
      ? list.filter(one => one !== id)
      : [...list, id].slice(-MAX_ROWS),
  )
}

// Runs from a press only: $.ui.view needs the person's own input, and only
// the terminal draws a main view it can switch.
async function showAgent($: $, agentId: string | undefined): Promise<void> {
  const moved = await $.ui.view(agentId === undefined ? {} : { agentId })
  if (moved.deny !== undefined) {
    $.ui.toast(`Couldn't open the transcript: ${moved.deny}`)
  }
}

type Placed = { row: AgentRow; depth: number }

// Active agents first (in start order), then finished ones (newest first).
// A nested agent follows its parent, indented.
function ordered(rows: readonly AgentRow[]): Placed[] {
  const ids = new Set(rows.map(row => row.id))
  const children = new Map<string, AgentRow[]>()
  const roots: AgentRow[] = []

  for (const row of rows) {
    if (row.parentId !== undefined && ids.has(row.parentId)) {
      const siblings = children.get(row.parentId) ?? []
      siblings.push(row)
      children.set(row.parentId, siblings)
    } else {
      roots.push(row)
    }
  }

  const rank = (row: AgentRow): number => (isActive(row.status) ? 0 : 1)
  roots.sort((a, b) => {
    const byRank = rank(a) - rank(b)
    if (byRank !== 0) return byRank

    return rank(a) === 0
      ? a.startedAt - b.startedAt
      : (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)
  })

  const placed: Placed[] = []
  const walk = (row: AgentRow, depth: number): void => {
    if (depth > 8) return
    placed.push({ row, depth })
    for (const child of children.get(row.id) ?? []) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 0)

  return placed
}

// Tool calls of the last minutes, in 10-second buckets.
function buckets(beats: readonly number[], now: number, count: number): number[] {
  const last = Math.floor(now / SPARK_BUCKET_MS)
  const counts = new Array<number>(count).fill(0)
  for (const at of beats) {
    const index = count - 1 - (last - Math.floor(at / SPARK_BUCKET_MS))
    if (index >= 0 && index < count) counts[index] = (counts[index] ?? 0) + 1
  }

  return counts
}

function sparkText(counts: readonly number[]): string {
  const top = Math.max(1, ...counts)

  return counts
    .map(count => {
      const level = Math.round((count / top) * (SPARK_BARS.length - 1))

      return count === 0 ? '▁' : (SPARK_BARS[Math.max(1, level)] ?? '▁')
    })
    .join('')
}

function sparkSvg(counts: readonly number[]): string {
  const top = Math.max(1, ...counts)
  const bars = counts
    .map((count, index) => {
      const height = count === 0 ? 1.5 : Math.max(3, (count / top) * 16)
      const isLast = index === counts.length - 1
      const fill = isLast ? String(ACTIVE) : '#888780'
      const opacity = isLast ? 1 : count === 0 ? 0.35 : 0.75

      return `<rect x="${index * 6}" y="${(18 - height).toFixed(1)}" width="4" height="${height.toFixed(1)}" rx="1.5" fill="${fill}" opacity="${opacity}"/>`
    })
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${counts.length * 6}" height="18" viewBox="0 0 ${counts.length * 6} 18">${bars}</svg>`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'subagents',
      description: 'Open the subagents panel',
    })
    try {
      // No second toast for agents that finished before a reload.
      await update($, agents, rows =>
        rows.map(row =>
          isEnded(row.status) ? { ...row, isNotified: true } : row,
        ),
      )
      await sync($)
      const rows = await read($, agents)
      if (rows.some(row => isActive(row.status))) void autoOpen($)
    } catch {
      // If the list can't be read, the events fill it in.
    }
    $.clock.every(TICK_MS, () => {
      onTick($).catch(() => undefined)
    })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, agents, () => [])
      await update($, pulses, () => [])
      await update($, expanded, () => [])
      await update($, isClosedByPerson, () => false)
    }

    return next(e)
  })

  on('command.run', { command: 'subagents' }, async $ => {
    await update($, isClosedByPerson, () => false)
    const opened = await $.ui.open({ id: PANE, title: TITLE })

    return {
      text: opened.isPlaced
        ? 'Subagents panel opened.'
        : `The panel is open but not drawn yet: ${opened.reason}`,
    }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await update($, isClosedByPerson, () => true)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined || started.agentId === undefined) {
      return started
    }

    const id = started.agentId
    const now = await $.clock.now()
    await update($, agents, rows =>
      upsert(rows, {
        id,
        type: e.subagentType,
        description: e.description,
        model: started.model,
        parentId: e.parentAgentId,
        isTeammate: e.isTeammate,
        isWorkflow: e.workflow !== undefined ? true : undefined,
        status: 'running',
        startedAt: now,
        tokens: 0,
        toolCount: 0,
      }),
    )
    void autoOpen($)

    return started
  }).catch(($, e, next) => next(e))

  // What a subagent is doing right now: the activity line and the sparkline.
  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (id === undefined) return next(e)

    const label = describeTool(
      String(e.tool),
      e as unknown as Readonly<Record<string, unknown>>,
    )
    const now = await $.clock.now()
    await update($, agents, rows =>
      patch(rows, id, row => ({
        ...row,
        activity: label,
        isToolRunning: true,
        toolCount: row.toolCount + 1,
      })),
    )
    await update($, pulses, list => [...list, now].slice(-PULSE_KEEP))

    const ran = await next(e)
    await update($, agents, rows =>
      patch(rows, id, row =>
        row.activity === label ? { ...row, isToolRunning: false } : row,
      ),
    )

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const id = e.agentId
    if (id === undefined) return result

    const usage = result.usage
    const effort = e.effort === undefined ? undefined : String(e.effort)
    try {
      await update($, agents, rows =>
        patch(rows, id, row => ({
          ...row,
          tokens: usage === null ? row.tokens : contextTokens(usage),
          model: usage?.model ?? e.model ?? row.model,
          effort: effort ?? row.effort,
        })),
      )
    } catch {
      // The agent keeps working even when its numbers can't be shown.
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const id = e.agentId
    if (id === undefined) return result

    const now = await $.clock.now()
    const status: AgentRowStatus =
      e.reason === 'answer'
        ? 'completed'
        : e.reason === 'aborted'
          ? 'killed'
          : 'failed'

    const answer = clipAnswer(e.answer)
    await update($, agents, rows =>
      patch(rows, id, row =>
        row.isTeammate === true
          ? { ...row, status: 'idle', isToolRunning: false, answer: answer ?? row.answer }
          : { ...row, status, endedAt: now, isToolRunning: false, answer: answer ?? row.answer },
      ),
    )
    await notifyFinished($)

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    // The terminal draws no SVG: decide by surface, not by the table's keys.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : undefined
    const rows = await read($, agents)
    // Subscribes the pane to the 1-second tick (timers, terminal animation).
    const frame = await read($, tick)
    const beats = await read($, pulses)
    const openIds = new Set(await read($, expanded))
    const now = await $.clock.now()
    const viewed = e.props.view.agentId
    const columns = e.props.bodyColumns
    const isTerminal = e.surface === 'terminal'
    // Only the terminal draws a main view that can switch to an agent's
    // transcript; elsewhere a press opens the card's details.
    const canView = isTerminal

    // Named steps on graphical surfaces, cells on the terminal.
    const space = (step: 'xs' | 'sm' | 'md', cells: number): Space =>
      isTerminal ? cells : step

    const gridColumns =
      columns >= GRID_FROM ? Math.min(3, Math.floor(columns / GRID_CELL)) : 1
    const layout =
      columns < SNUG_FROM ? 'compact' : gridColumns > 1 ? 'grid' : 'stack'
    // Cells one card gets across, which decides how much it shows per line.
    const cardColumns = Math.floor(columns / gridColumns)

    const press = (row: AgentRow) =>
      canView
        ? () => void showAgent($, row.id === viewed ? undefined : row.id)
        : () => void toggleDetails($, row.id)

    const statusMark = (row: AgentRow): string =>
      row.status === 'running' && isTerminal ? spinnerFrame(frame) : MARK[row.status]

    const elapsed = (row: AgentRow): string =>
      formatElapsed((row.endedAt ?? now) - row.startedAt)

    const modelParts = (row: AgentRow): string[] =>
      [shortModel(row.model), effortText(row.effort)].filter(
        (part): part is string => part !== undefined,
      )

    const costParts = (row: AgentRow): string[] =>
      [
        row.tokens > 0 ? formatTokens(row.tokens) : undefined,
        row.toolCount > 0 ? plural(row.toolCount, 'tool') : undefined,
      ].filter((part): part is string => part !== undefined)

    const avatar = (row: AgentRow, size: number) => {
      const mood = MOOD[row.status]
      if (Svg === undefined) {
        return (
          <Text color={identityColor(row.id)} weight="bold">
            {creatureFace(mood, frame)}
          </Text>
        )
      }
      // Animated only while it matters: active, idle or just finished.
      const isLively =
        !isEnded(row.status) || now - (row.endedAt ?? now) < FRESH_MS

      return (
        <Svg
          source={creatureSvg(row.id, mood, size)}
          alt={`${row.type}: ${LABEL[row.status]}`}
          width={size}
          height={size}
          isInteractive={isLively}
        />
      )
    }

    // The third line: what the agent does now, or how it ended.
    const stateLine = (row: AgentRow) =>
      isActive(row.status) && row.activity !== undefined ? (
        <Text
          color={row.isToolRunning === true ? ACTIVE : undefined}
          dimColor={row.isToolRunning !== true}
          wrap="truncate-end"
        >
          ↳ {row.activity}
        </Text>
      ) : (
        <Text color={COLOR[row.status]} dimColor={COLOR[row.status] === undefined}>
          {MARK[row.status]} {LABEL[row.status]}
        </Text>
      )

    const title = (row: AgentRow) => (
      <Button key={row.id} plain dimColor={!isActive(row.status)} onPress={press(row)}>
        <Text weight="semibold">{row.type}</Text>
        {!canView ? (
          <Text dimColor> {openIds.has(row.id) ? '▾' : '▸'}</Text>
        ) : row.id === viewed ? (
          <Text color={VIEWED}> ◀</Text>
        ) : (
          <Text dimColor> ↗</Text>
        )}
      </Button>
    )

    // The opened card's details: what a transcript would have told you.
    const details = (row: AgentRow) => {
      const lines = [
        ['Model', row.model],
        ['Started', `${clockTime(row.startedAt)} · ${plural(row.toolCount, 'tool')}`],
        ['Last tool', row.activity],
        ['Agent id', row.id],
      ].filter((line): line is [string, string] => line[1] !== undefined)

      return (
        <Box
          flexDirection="column"
          rowGap={space('xs', 0)}
          marginTop={space('xs', 0)}
          paddingLeft={space('sm', 1)}
        >
          {lines.map(([label, value]) => (
            <Text size="caption" wrap="truncate-end">
              <Text dimColor>{label}  </Text>
              {value}
            </Text>
          ))}
          {row.answer !== undefined ? (
            <Box flexDirection="column">
              <Text dimColor size="caption">
                Answer
              </Text>
              <Text size="caption" wrap="wrap">
                {row.answer}
              </Text>
            </Box>
          ) : undefined}
        </Box>
      )
    }

    const clock = (row: AgentRow) => (
      <Text color={COLOR[row.status]} dimColor={COLOR[row.status] === undefined} tabular>
        {statusMark(row)} {elapsed(row)}
      </Text>
    )

    const card = (row: AgentRow, indent: number) => {
      const active = isActive(row.status)
      const isViewed = row.id === viewed
      const isSnug = cardColumns - indent < REGULAR_FROM
      const isOpen = !canView && openIds.has(row.id)
      const meta = [...modelParts(row), ...costParts(row)]

      return (
        <Box
          key={`card-${row.id}`}
          flexDirection="row"
          alignItems="flex-start"
          columnGap={space('md', 1)}
          borderStyle="round"
          borderColor={isViewed ? VIEWED : (COLOR[row.status] ?? 'inactive')}
          borderDimColor={!active && !isViewed}
          hover={{ borderColor: ACTIVE }}
          paddingX={space('md', 1)}
          paddingY={space('sm', 0)}
          marginLeft={indent}
        >
          {avatar(row, isSnug ? 36 : 44)}
          <Box
            flexDirection="column"
            rowGap={space('xs', 0)}
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
          >
            <Box flexDirection="row" justifyContent="space-between" columnGap={space('sm', 1)}>
              {title(row)}
              {clock(row)}
            </Box>
            <Text dimColor={!active} wrap={isOpen ? 'wrap' : 'truncate-end'}>
              {row.description}
            </Text>
            {stateLine(row)}
            {isSnug ? (
              <Box flexDirection="column">
                {modelParts(row).length > 0 ? (
                  <Text dimColor size="caption" wrap="truncate-end">
                    {modelParts(row).join(' · ')}
                  </Text>
                ) : undefined}
                {costParts(row).length > 0 ? (
                  <Text dimColor size="caption" wrap="truncate-end">
                    {costParts(row).join(' · ')}
                  </Text>
                ) : undefined}
              </Box>
            ) : meta.length > 0 ? (
              <Text dimColor size="caption" wrap="truncate-end">
                {meta.join(' · ')}
              </Text>
            ) : undefined}
            {isOpen ? details(row) : undefined}
          </Box>
        </Box>
      )
    }

    const compactRow = (row: AgentRow, indent: number) => (
      <Box
        flexDirection="row"
        alignItems="center"
        columnGap={space('sm', 1)}
        paddingY={space('xs', 0)}
        marginLeft={indent}
      >
        {avatar(row, 28)}
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
          <Box flexDirection="row" justifyContent="space-between" columnGap={space('xs', 1)}>
            {title(row)}
            {clock(row)}
          </Box>
          {isActive(row.status) && row.activity !== undefined ? (
            stateLine(row)
          ) : (
            <Text dimColor size="caption" wrap="truncate-end">
              {[LABEL[row.status], ...costParts(row).slice(0, 1)].join(' · ')}
            </Text>
          )}
          {!canView && openIds.has(row.id) ? (
            <Box flexDirection="column">
              <Text dimColor size="caption" wrap="wrap">
                {row.description}
              </Text>
              {details(row)}
            </Box>
          ) : undefined}
        </Box>
      </Box>
    )

    if (rows.length === 0) {
      return (
        <Box
          flexDirection="column"
          alignItems="center"
          rowGap={space('xs', 0)}
          paddingY={space('md', 1)}
        >
          {Svg !== undefined ? (
            <Svg
              source={creatureSvg('subagent-monitor', 'idle', 56)}
              alt="A sleeping creature"
              width={56}
              height={56}
              isInteractive
            />
          ) : (
            <Text dimColor>(-.-) zZ</Text>
          )}
          <Text weight="semibold">No subagents yet</Text>
          <Text dimColor size="caption">
            They show up here when an agent starts.
          </Text>
        </Box>
      )
    }

    const activeCount = rows.filter(row => isActive(row.status)).length
    const doneCount = rows.filter(row => row.status === 'completed').length
    const failedCount = rows.filter(
      row => row.status === 'failed' || row.status === 'killed',
    ).length
    const totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0)
    const totalTools = rows.reduce((sum, row) => sum + row.toolCount, 0)
    const sparkCount = Math.max(10, Math.min(30, columns - 16))
    const counts = buckets(beats, now, sparkCount)
    const hasPulse = counts.some(count => count > 0)
    const isNarrowHeader = columns < REGULAR_FROM

    const header = (
      <Box flexDirection="column" rowGap={space('xs', 0)}>
        <Box
          flexDirection={isNarrowHeader ? 'column' : 'row'}
          justifyContent="space-between"
          columnGap={space('sm', 1)}
        >
          <Text>
            <Text color={activeCount > 0 ? ACTIVE : undefined} dimColor={activeCount === 0} weight="semibold">
              {activeCount > 0 && isTerminal ? spinnerFrame(frame) : '●'} {activeCount} active
            </Text>
            <Text color={DONE}>  ✓ {doneCount}</Text>
            {failedCount > 0 ? <Text color="error">  ✗ {failedCount}</Text> : undefined}
          </Text>
          <Text dimColor tabular>
            Σ {formatTokens(totalTokens)} · {plural(totalTools, 'tool')}
          </Text>
        </Box>
        {hasPulse ? (
          <Box flexDirection="row" alignItems="center" columnGap={space('sm', 1)}>
            {Svg !== undefined ? (
              <Svg
                source={sparkSvg(counts)}
                alt={`Activity: ${counts.reduce((a, b) => a + b, 0)} tool calls in the last ${counts.length * 10} seconds`}
                width={counts.length * 6}
                height={18}
              />
            ) : (
              <Text color={ACTIVE}>{sparkText(counts)}</Text>
            )}
            <Text dimColor size="caption">
              activity · {Math.max(1, Math.round((counts.length * SPARK_BUCKET_MS) / 60_000))} min
            </Text>
          </Box>
        ) : undefined}
      </Box>
    )

    const placed = ordered(rows)
    const list =
      layout === 'compact' ? (
        <Box flexDirection="column" rowGap={space('xs', 0)}>
          {placed.map(({ row, depth }) => compactRow(row, depth))}
        </Box>
      ) : layout === 'grid' ? (
        <Box flexDirection="row" flexWrap="wrap">
          {placed.map(({ row }) => (
            <Box
              width={`${Math.floor(100 / gridColumns)}%`}
              paddingRight={space('sm', 1)}
              paddingBottom={space('sm', 0)}
            >
              {card(row, 0)}
            </Box>
          ))}
        </Box>
      ) : (
        <Box flexDirection="column" rowGap={space('sm', 0)}>
          {placed.map(({ row, depth }) => card(row, depth * 2))}
        </Box>
      )

    return (
      <Box flexDirection="column" rowGap={space('md', 1)}>
        {viewed !== undefined ? (
          <Button key="main" onPress={() => void showAgent($, undefined)}>
            ← Back to main chat
          </Button>
        ) : undefined}
        {header}
        {list}
      </Box>
    )
  })
}
