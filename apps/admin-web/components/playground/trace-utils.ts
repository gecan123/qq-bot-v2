import type { RunTrace, TimelineFilter, TraceEvent } from "./types";

export interface TraceGroup {
  id: string;
  title: string;
  phase: TraceEvent["phase"];
  loopIndex: number | null;
  events: TraceEvent[];
}

export interface RunComparison {
  loopDelta: number;
  toolDelta: number;
  finalAnswerChanged: boolean;
  phaseElapsedDiffs: Partial<Record<TraceEvent["phase"], number>>;
  addedSummaries: string[];
  removedSummaries: string[];
}

export function filterTraceEvents(trace: RunTrace, filter: TimelineFilter): TraceEvent[] {
  switch (filter) {
    case "all":
      return trace.events;
    case "loop":
      return trace.events.filter((event) => event.phase === "loop");
    case "think":
      return trace.events.filter((event) => event.type === "think");
    case "tool":
      return trace.events.filter(
        (event) => event.type === "tool_call" || event.type === "tool_result",
      );
  }
}

export function groupTraceEvents(trace: RunTrace, filter: TimelineFilter): TraceGroup[] {
  const groups: TraceGroup[] = [];
  const groupMap = new Map<string, TraceGroup>();

  for (const event of filterTraceEvents(trace, filter)) {
    const isLoopGroup = event.phase === "loop" && event.loopIndex != null;
    const id = isLoopGroup ? `loop:${event.loopIndex}` : `phase:${event.phase}`;
    const existing = groupMap.get(id);

    if (existing) {
      existing.events.push(event);
      continue;
    }

    const group = {
      id,
      title: isLoopGroup ? `第 ${event.loopIndex} 轮` : toPhaseLabel(event.phase),
      phase: event.phase,
      loopIndex: event.loopIndex,
      events: [event],
    };
    groupMap.set(id, group);
    groups.push(group);
  }

  return groups;
}

export function getLoopCount(trace: RunTrace): number {
  return new Set(
    trace.events
      .filter((event) => event.phase === "loop" && event.loopIndex != null)
      .map((event) => event.loopIndex),
  ).size;
}

export function getToolCount(trace: RunTrace): number {
  return trace.events.filter((event) => event.type === "tool_call").length;
}

export function compareRuns(current: RunTrace, previous: RunTrace | null): RunComparison {
  if (!previous) {
    return {
      loopDelta: getLoopCount(current),
      toolDelta: getToolCount(current),
      finalAnswerChanged: false,
      phaseElapsedDiffs: summarizePhaseDiffs(current, null),
      addedSummaries: current.events.map((event) => event.summary),
      removedSummaries: [],
    };
  }

  const currentSummaries = new Set(current.events.map((event) => event.summary));
  const previousSummaries = new Set(previous.events.map((event) => event.summary));

  return {
    loopDelta: getLoopCount(current) - getLoopCount(previous),
    toolDelta: getToolCount(current) - getToolCount(previous),
    finalAnswerChanged: current.finalAnswer !== previous.finalAnswer,
    phaseElapsedDiffs: summarizePhaseDiffs(current, previous),
    addedSummaries: [...currentSummaries].filter((summary) => !previousSummaries.has(summary)),
    removedSummaries: [...previousSummaries].filter((summary) => !currentSummaries.has(summary)),
  };
}

function summarizePhaseDiffs(current: RunTrace, previous: RunTrace | null) {
  const phases: TraceEvent["phase"][] = ["receive", "load_context", "plan", "loop", "finalize"];
  const diffs: Partial<Record<TraceEvent["phase"], number>> = {};

  for (const phase of phases) {
    const currentElapsed = maxElapsedForPhase(current, phase);
    const previousElapsed = previous ? maxElapsedForPhase(previous, phase) : 0;
    diffs[phase] = currentElapsed - previousElapsed;
  }

  return diffs;
}

function maxElapsedForPhase(trace: RunTrace, phase: TraceEvent["phase"]) {
  return trace.events
    .filter((event) => event.phase === phase)
    .reduce((max, event) => Math.max(max, event.elapsedMs), 0);
}

function toPhaseLabel(phase: TraceEvent["phase"]) {
  switch (phase) {
    case "receive":
      return "收到请求";
    case "load_context":
      return "加载上下文";
    case "plan":
      return "准备阶段";
    case "loop":
      return "循环判断";
    case "finalize":
      return "整理结果";
  }
}
