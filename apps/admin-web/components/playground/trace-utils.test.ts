import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  compareRuns,
  filterTraceEvents,
  getLoopCount,
  getToolCount,
  groupTraceEvents,
} from "./trace-utils";
import type { RunTrace } from "./types";

function makeTrace(overrides: Partial<RunTrace> = {}): RunTrace {
  return {
    runId: "run_1",
    groupId: 42,
    senderName: "tester",
    userMessage: "hello",
    startedAt: 1,
    endedAt: 100,
    elapsedMs: 99,
    finalState: "final",
    finalAnswer: "done",
    terminationReason: "final_answer",
    events: [
      {
        id: "evt_1",
        type: "phase_started",
        phase: "receive",
        loopIndex: null,
        timestamp: 1,
        elapsedMs: 0,
        title: "receive",
        summary: "request accepted",
        raw: null,
      },
      {
        id: "evt_2",
        type: "loop_started",
        phase: "loop",
        loopIndex: 1,
        timestamp: 10,
        elapsedMs: 9,
        title: "loop 1",
        summary: "loop 1 started",
        raw: null,
      },
      {
        id: "evt_3",
        type: "think",
        phase: "loop",
        loopIndex: 1,
        timestamp: 11,
        elapsedMs: 10,
        title: "think",
        summary: "inspect memory",
        raw: "inspect memory",
      },
      {
        id: "evt_4",
        type: "tool_call",
        phase: "loop",
        loopIndex: 1,
        timestamp: 12,
        elapsedMs: 11,
        title: "tool call",
        summary: "call db_read",
        raw: { callId: "c1" },
      },
      {
        id: "evt_5",
        type: "tool_result",
        phase: "loop",
        loopIndex: 1,
        timestamp: 13,
        elapsedMs: 12,
        title: "tool result",
        summary: "db_read returned",
        raw: { callId: "c1" },
      },
      {
        id: "evt_6",
        type: "run_finished",
        phase: "finalize",
        loopIndex: null,
        timestamp: 99,
        elapsedMs: 98,
        title: "finish",
        summary: "final answer",
        raw: null,
      },
    ],
    ...overrides,
  };
}

describe("trace-utils", () => {
  test("filters events by think and tool views", () => {
    const trace = makeTrace();

    assert.equal(filterTraceEvents(trace, "all").length, 6);
    assert.equal(filterTraceEvents(trace, "think").length, 1);
    assert.deepEqual(
      filterTraceEvents(trace, "tool").map((event) => event.type),
      ["tool_call", "tool_result"],
    );
  });

  test("groups events into loop and phase sections", () => {
    const trace = makeTrace();
    const groups = groupTraceEvents(trace, "all");

    assert.deepEqual(
      groups.map((group) => group.id),
      ["phase:receive", "loop:1", "phase:finalize"],
    );
    assert.equal(groups[1]?.events.length, 4);
  });

  test("computes comparison summary between runs", () => {
    const current = makeTrace({ finalAnswer: "new answer", elapsedMs: 120 });
    const previous = makeTrace({
      runId: "run_prev",
      finalAnswer: "old answer",
      events: makeTrace().events.filter((event) => event.type !== "think"),
    });

    const comparison = compareRuns(current, previous);

    assert.equal(getLoopCount(current), 1);
    assert.equal(getToolCount(current), 1);
    assert.equal(comparison.finalAnswerChanged, true);
    assert.ok(comparison.addedSummaries.includes("inspect memory"));
  });
});
