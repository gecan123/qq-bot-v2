"use client";

import { ChevronRight, RotateCw, Wrench, Brain, Flag } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { RunTrace, TimelineFilter, TraceEvent } from "./types";
import { getLoopCount, getToolCount, groupTraceEvents } from "./trace-utils";

interface RunTimelineProps {
  trace: RunTrace;
  filter: TimelineFilter;
  selectedEventId: string | null;
  autoExpandLoops: boolean;
  onSelectEvent: (eventId: string) => void;
}

export function RunTimeline({
  trace,
  filter,
  selectedEventId,
  autoExpandLoops,
  onSelectEvent,
}: RunTimelineProps) {
  const groups = groupTraceEvents(trace, filter);

  return (
    <Card className="border-slate-200 bg-white">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold text-slate-800">本次运行过程</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-slate-400">最终回复</p>
          <p className="mt-2 text-sm text-slate-700 whitespace-pre-wrap">
            {trace.finalAnswer ?? "这次没有产出最终回复。"}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-slate-700">
            <span className="rounded-full bg-white px-2 py-1 text-xs">{toStateLabel(trace.finalState)}</span>
            <span className="rounded-full bg-white px-2 py-1 text-xs">{toTerminationLabel(trace.terminationReason)}</span>
            <span className="rounded-full bg-white px-2 py-1 text-xs">{getLoopCount(trace)} 轮</span>
            <span className="rounded-full bg-white px-2 py-1 text-xs">调用工具 {getToolCount(trace)} 次</span>
            <span className="rounded-full bg-white px-2 py-1 text-xs">
              总耗时 {(trace.elapsedMs / 1000).toFixed(1)}s
            </span>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            下面按顺序展示：收到请求、加载上下文、准备、每一轮判断，以及最后怎么结束。
          </p>
        </div>

        {groups.map((group) => (
          <details
            key={group.id}
            open={group.phase === "loop" ? autoExpandLoops : true}
            className="rounded-xl border border-slate-200 bg-slate-50"
          >
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-slate-800">
              <ChevronRight className="h-4 w-4 text-slate-400" />
              <span>{group.title}</span>
              <span className="ml-auto text-xs text-slate-400">{group.events.length} 个步骤</span>
            </summary>
            <div className="space-y-2 border-t border-slate-200 px-3 py-3">
              {group.events.map((event) => (
                <button
                  key={event.id}
                  type="button"
                  onClick={() => onSelectEvent(event.id)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-lg border px-3 py-3 text-left transition-colors",
                    selectedEventId === event.id
                      ? "border-indigo-300 bg-indigo-50"
                      : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50",
                  )}
                >
                  <span className="mt-0.5 rounded-md bg-slate-100 p-1.5 text-slate-500">
                    <EventIcon event={event} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm font-medium text-slate-800">{toEventTitle(event)}</span>
                      <span className="shrink-0 text-[11px] text-slate-400">{event.elapsedMs}ms</span>
                    </span>
                    <span className="mt-1 block text-xs text-slate-500 whitespace-pre-wrap">
                      {toEventSummary(event)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </details>
        ))}
      </CardContent>
    </Card>
  );
}

function EventIcon({ event }: { event: TraceEvent }) {
  if (event.type === "think") return <Brain className="h-3.5 w-3.5" />;
  if (event.type === "tool_call" || event.type === "tool_result") {
    return <Wrench className="h-3.5 w-3.5" />;
  }
  if (event.phase === "loop") return <RotateCw className="h-3.5 w-3.5" />;
  return <Flag className="h-3.5 w-3.5" />;
}

function toStateLabel(state: RunTrace["finalState"]) {
  switch (state) {
    case "final":
      return "已完成";
    case "fallback":
      return "降级结束";
    case "aborted":
      return "中止";
  }
}

function toTerminationLabel(reason: RunTrace["terminationReason"]) {
  switch (reason) {
    case "final_answer":
      return "正常生成最终回复";
    case "implicit_text":
      return "模型直接给了文本";
    case "empty_response":
      return "模型没有返回内容";
    case "max_steps_exceeded":
      return "超过最大循环次数";
    case "tool_error":
      return "工具调用报错";
    case "runtime_error":
      return "运行时报错";
  }
}

function toEventTitle(event: TraceEvent) {
  if (event.phase === "loop" && event.type === "think") return "这一轮在想什么";
  if (event.type === "tool_call") return "开始调用工具";
  if (event.type === "tool_result") return "工具返回结果";
  if (event.type === "decision") return "做出决定";
  if (event.type === "phase_started") return "进入阶段";
  if (event.type === "phase_finished") return "阶段完成";
  if (event.type === "loop_started") return "开始新一轮";
  if (event.type === "loop_finished") return "这一轮结束";
  if (event.type === "run_finished") return "本次运行结束";
  if (event.type === "run_aborted") return "本次运行中止";
  if (event.type === "run_error") return "本次运行报错";
  return event.title;
}

function toEventSummary(event: TraceEvent) {
  if (event.phase === "loop" && event.type === "think") {
    return `Agent 当时的想法：${event.summary}`;
  }
  if (event.type === "tool_call") {
    return `这一步准备调用工具。${event.summary}`;
  }
  if (event.type === "tool_result") {
    return `工具已经返回。${event.summary}`;
  }
  if (event.type === "decision") {
    return `这一步做出的判断：${event.summary}`;
  }
  return event.summary;
}
