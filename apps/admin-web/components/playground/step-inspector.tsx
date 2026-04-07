"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { RunTrace, TraceEvent } from "./types";
import { compareRuns } from "./trace-utils";

interface StepInspectorProps {
  event: TraceEvent | null;
  trace: RunTrace;
  comparisonTrace: RunTrace | null;
  showRawThink: boolean;
}

type InspectorTab = "summary" | "raw-think" | "tool-io" | "raw-event";

export function StepInspector({
  event,
  trace,
  comparisonTrace,
  showRawThink,
}: StepInspectorProps) {
  const [tab, setTab] = useState<InspectorTab>("summary");
  const comparison = compareRuns(trace, comparisonTrace);

  return (
    <Card className="border-slate-200 bg-white">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold text-slate-800">这一步的细节</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2">
          <SummaryPill label="轮数变化" value={withSign(comparison.loopDelta)} />
          <SummaryPill label="工具次数变化" value={withSign(comparison.toolDelta)} />
          <SummaryPill
            label="最终回复"
            value={comparison.finalAnswerChanged ? "有变化" : "没变化"}
          />
          <SummaryPill
            label="阶段耗时对比"
            value={Object.entries(comparison.phaseElapsedDiffs)
              .map(([phase, diff]) => `${toPhaseLabel(phase)}:${withSign(diff ?? 0)}`)
              .join(" ")}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <TabButton active={tab === "summary"} onClick={() => setTab("summary")}>
            说明
          </TabButton>
          <TabButton active={tab === "raw-think"} onClick={() => setTab("raw-think")}>
            原始思考
          </TabButton>
          <TabButton active={tab === "tool-io"} onClick={() => setTab("tool-io")}>
            工具输入输出
          </TabButton>
          <TabButton active={tab === "raw-event"} onClick={() => setTab("raw-event")}>
            原始事件
          </TabButton>
        </div>

        {!event ? (
          <p className="rounded-xl border border-dashed border-slate-200 px-4 py-10 text-sm text-slate-400">
            从时间线里选择一个 event 查看细节。
          </p>
        ) : (
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
            {tab === "summary" && (
              <div className="space-y-3 text-sm text-slate-700">
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-400">这一步在干嘛</p>
                  <p className="mt-1 font-medium text-slate-800">{humanTitle(event)}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-400">简要解释</p>
                  <p className="mt-1 whitespace-pre-wrap">{humanSummary(event)}</p>
                </div>
                <div className="grid gap-2 sm:grid-cols-3 text-xs text-slate-500">
                  <SummaryPill label="阶段" value={toPhaseLabel(event.phase)} />
                  <SummaryPill label="第几轮" value={event.loopIndex == null ? "-" : `第 ${event.loopIndex} 轮`} />
                  <SummaryPill label="发生时间" value={`${event.elapsedMs}ms`} />
                </div>
              </div>
            )}

            {tab === "raw-think" && (
              <pre className="overflow-x-auto whitespace-pre-wrap break-words text-sm text-slate-700">
                {showRawThink
                  ? event.type === "think"
                    ? stringifyRaw(event.raw)
                    : "当前 event 不是 think。"
                  : "Raw think 已隐藏，打开上方开关后可查看。"}
              </pre>
            )}

            {tab === "tool-io" && (
              <pre className="overflow-x-auto whitespace-pre-wrap break-words text-sm text-slate-700">
                {event.type === "tool_call" || event.type === "tool_result"
                  ? stringifyRaw(event.raw)
                  : "当前 event 不包含 tool input/output。"}
              </pre>
            )}

            {tab === "raw-event" && (
              <pre className="overflow-x-auto whitespace-pre-wrap break-words text-sm text-slate-700">
                {JSON.stringify(event, null, 2)}
              </pre>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SummaryPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 text-xs text-slate-700">{value}</p>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md border px-3 py-1.5 text-xs transition-colors",
        active
          ? "border-indigo-300 bg-indigo-50 text-indigo-700"
          : "border-slate-200 bg-white text-slate-500 hover:text-slate-700",
      )}
    >
      {children}
    </button>
  );
}

function stringifyRaw(raw: unknown) {
  return typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
}

function withSign(value: number) {
  return value > 0 ? `+${value}` : String(value);
}

function toPhaseLabel(phase: string) {
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
    default:
      return phase;
  }
}

function humanTitle(event: TraceEvent) {
  if (event.type === "think") return "Agent 当时的想法";
  if (event.type === "tool_call") return "准备调用工具";
  if (event.type === "tool_result") return "工具返回结果";
  if (event.type === "decision") return "这一步做出的决定";
  return event.title;
}

function humanSummary(event: TraceEvent) {
  if (event.type === "think") return `它当时这样想：${event.summary}`;
  if (event.type === "tool_call") return `这一步决定去调用工具：${event.summary}`;
  if (event.type === "tool_result") return `工具返回后得到的信息：${event.summary}`;
  if (event.type === "decision") return `决定原因：${event.summary}`;
  return event.summary;
}
