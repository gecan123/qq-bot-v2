export type TracePhase = "receive" | "load_context" | "plan" | "loop" | "finalize";

export type TraceEventType =
  | "run_started"
  | "phase_started"
  | "think"
  | "loop_started"
  | "tool_call"
  | "tool_result"
  | "decision"
  | "loop_finished"
  | "phase_finished"
  | "run_finished"
  | "run_aborted"
  | "run_error";

export type TraceTerminationReason =
  | "final_answer"
  | "implicit_text"
  | "empty_response"
  | "max_steps_exceeded"
  | "tool_error"
  | "runtime_error";

export interface TraceEvent {
  id: string;
  type: TraceEventType;
  phase: TracePhase;
  loopIndex: number | null;
  timestamp: number;
  elapsedMs: number;
  title: string;
  summary: string;
  raw: unknown;
}

export interface RunTrace {
  runId: string;
  groupId: number;
  senderName: string;
  userMessage: string;
  startedAt: number;
  endedAt: number;
  elapsedMs: number;
  finalState: "final" | "fallback" | "aborted";
  finalAnswer?: string;
  terminationReason: TraceTerminationReason;
  events: TraceEvent[];
}

export type TimelineFilter = "all" | "loop" | "think" | "tool";

export interface PlaygroundRunResult {
  state: "final" | "fallback" | "aborted";
  answer?: string;
  reason?: string;
  finalAnswerPayload?: Record<string, unknown>;
  elapsedMs: number;
  trace: RunTrace;
  llmContext: {
    systemPrompt: string;
    messages: Array<{ role: "user"; content: string }>;
    tools: string[];
  };
}
