export type TracePhase = 'receive' | 'load_context' | 'plan' | 'loop' | 'finalize'

export type TraceEventType =
  | 'run_started'
  | 'phase_started'
  | 'think'
  | 'loop_started'
  | 'tool_call'
  | 'tool_result'
  | 'decision'
  | 'loop_finished'
  | 'phase_finished'
  | 'run_finished'
  | 'run_aborted'
  | 'run_error'

export type TraceTerminationReason =
  | 'final_answer'
  | 'implicit_text'
  | 'empty_response'
  | 'max_steps_exceeded'
  | 'tool_error'
  | 'runtime_error'

export interface TraceEvent {
  id: string
  type: TraceEventType
  phase: TracePhase
  loopIndex: number | null
  timestamp: number
  elapsedMs: number
  title: string
  summary: string
  raw: unknown
}

export interface RunTrace {
  runId: string
  groupId: number
  senderName: string
  userMessage: string
  startedAt: number
  endedAt: number
  elapsedMs: number
  finalState: 'final' | 'fallback' | 'aborted'
  finalAnswer?: string
  terminationReason: TraceTerminationReason
  events: TraceEvent[]
}

interface TraceRecorderInput {
  runId: string
  groupId: number
  senderName: string
  userMessage: string
}

interface TraceRecorderFinishInput {
  finalState: RunTrace['finalState']
  finalAnswer?: string
  terminationReason: TraceTerminationReason
}

interface TraceRecorderPhaseFinishedInput {
  phase: TracePhase
  summary: string
  raw?: unknown
}

interface TraceRecorderEventInput {
  phase: TracePhase
  loopIndex?: number | null
  title?: string
  summary: string
  raw?: unknown
}

interface TraceRecorderToolCallInput {
  phase?: TracePhase
  loopIndex?: number | null
  callId: string
  name: string
  input: unknown
}

interface TraceRecorderToolResultInput {
  phase?: TracePhase
  loopIndex?: number | null
  callId: string
  name: string
  output?: string
  error?: string
  durationMs?: number
}

export interface TraceRecorder {
  phaseStarted: (phase: TracePhase, summary?: string, raw?: unknown) => TraceEvent
  phaseFinished: (input: TraceRecorderPhaseFinishedInput) => TraceEvent
  think: (input: TraceRecorderEventInput) => TraceEvent
  decision: (input: TraceRecorderEventInput) => TraceEvent
  loopStarted: (loopIndex: number, summary?: string, raw?: unknown) => TraceEvent
  loopFinished: (input: TraceRecorderEventInput) => TraceEvent
  toolCall: (input: TraceRecorderToolCallInput) => TraceEvent
  toolResult: (input: TraceRecorderToolResultInput) => TraceEvent
  error: (input: TraceRecorderEventInput) => TraceEvent
  finish: (input: TraceRecorderFinishInput) => RunTrace
}

function makeTitle(type: TraceEventType, phase: TracePhase, loopIndex: number | null, summary: string): string {
  switch (type) {
    case 'run_started':
      return 'Run started'
    case 'phase_started':
      return `Phase started: ${phase}`
    case 'think':
      return loopIndex != null ? `Loop #${loopIndex} think` : `${phase} think`
    case 'loop_started':
      return `Loop #${loopIndex ?? 0} started`
    case 'tool_call':
      return summary
    case 'tool_result':
      return summary
    case 'decision':
      return loopIndex != null ? `Loop #${loopIndex} decision` : `${phase} decision`
    case 'loop_finished':
      return `Loop #${loopIndex ?? 0} finished`
    case 'phase_finished':
      return `Phase finished: ${phase}`
    case 'run_finished':
      return 'Run finished'
    case 'run_aborted':
      return 'Run aborted'
    case 'run_error':
      return 'Run error'
  }
}

export function createTraceRecorder(input: TraceRecorderInput): TraceRecorder {
  const startedAt = Date.now()
  const events: TraceEvent[] = []
  let nextId = 1

  const push = (
    type: TraceEventType,
    phase: TracePhase,
    summary: string,
    raw: unknown = null,
    loopIndex: number | null = null,
    title?: string,
  ): TraceEvent => {
    const timestamp = Date.now()
    const event: TraceEvent = {
      id: `evt_${nextId++}`,
      type,
      phase,
      loopIndex,
      timestamp,
      elapsedMs: timestamp - startedAt,
      title: title ?? makeTitle(type, phase, loopIndex, summary),
      summary,
      raw,
    }
    events.push(event)
    return event
  }

  push('run_started', 'receive', 'playground run created', {
    groupId: input.groupId,
    senderName: input.senderName,
    userMessage: input.userMessage,
  })

  return {
    phaseStarted: (phase, summary = `${phase} started`, raw = null) => push('phase_started', phase, summary, raw),
    phaseFinished: ({ phase, summary, raw = null }) => push('phase_finished', phase, summary, raw),
    think: ({ phase, loopIndex = null, title, summary, raw = null }) => push('think', phase, summary, raw, loopIndex, title),
    decision: ({ phase, loopIndex = null, title, summary, raw = null }) => push('decision', phase, summary, raw, loopIndex, title),
    loopStarted: (loopIndex, summary = `loop #${loopIndex} started`, raw = null) =>
      push('loop_started', 'loop', summary, raw, loopIndex),
    loopFinished: ({ phase, loopIndex = null, title, summary, raw = null }) =>
      push('loop_finished', phase, summary, raw, loopIndex, title),
    toolCall: ({ phase = 'loop', loopIndex = null, callId, name, input: args }) =>
      push('tool_call', phase, `call ${name}`, { callId, name, input: args }, loopIndex, `Tool call: ${name}`),
    toolResult: ({ phase = 'loop', loopIndex = null, callId, name, output, error, durationMs }) =>
      push(
        'tool_result',
        phase,
        error ? `tool ${name} failed` : `tool ${name} returned`,
        { callId, name, output, error, durationMs },
        loopIndex,
        `Tool result: ${name}`,
      ),
    error: ({ phase, loopIndex = null, title, summary, raw = null }) => push('run_error', phase, summary, raw, loopIndex, title),
    finish: ({ finalState, finalAnswer, terminationReason }) => {
      const endedAt = Date.now()
      if (finalState === 'final') {
        push('run_finished', 'finalize', terminationReason, { finalAnswer, terminationReason })
      } else if (terminationReason === 'runtime_error') {
        push('run_error', 'finalize', terminationReason, { finalAnswer, terminationReason })
      } else {
        push('run_aborted', 'finalize', terminationReason, { finalAnswer, terminationReason })
      }

      return {
        runId: input.runId,
        groupId: input.groupId,
        senderName: input.senderName,
        userMessage: input.userMessage,
        startedAt,
        endedAt,
        elapsedMs: endedAt - startedAt,
        finalState,
        finalAnswer,
        terminationReason,
        events,
      }
    },
  }
}
