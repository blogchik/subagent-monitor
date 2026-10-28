export type AgentRowStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'killed'

/** One agent row of the panel. */
export type AgentRow = {
  id: string
  /** Explore, Plan, general-purpose, ... */
  type: string
  /** The short task text of the Agent call. */
  description: string
  model?: string
  /** The effort of the latest request: low ... max, or a number. */
  effort?: string
  /** The agent that spawned this one; absent when the main chat did. */
  parentId?: string
  isTeammate?: boolean
  isWorkflow?: boolean
  status: AgentRowStatus
  startedAt: number
  endedAt?: number
  /** Context size of the latest model request (input + cache + output). */
  tokens: number
  /** How many tools the agent called. */
  toolCount: number
  /** The latest tool call: "Grep · src/**". */
  activity?: string
  /** Whether that tool is still running. */
  isToolRunning?: boolean
  /** The start of the agent's final answer, once it has one. */
  answer?: string
  /** Whether the finish toast was shown. */
  isNotified?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'subagent-monitor': {
      agents: Shaped<AgentRow[]>
      /** When subagents called tools: feeds the activity sparkline. */
      pulses: number[]
      /** Ids of the cards whose details are open (graphical surfaces). */
      expanded: string[]
      /** Grows every second: redraws the timers and the terminal animation. */
      tick: number
      /** Whether the person closed the pane: then it does not open by itself. */
      isClosedByPerson: boolean
    }
  }
}
