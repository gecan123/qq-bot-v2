"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { GroupSummary } from "@/lib/queries";
import { RecentRuns } from "./recent-runs";
import { RunTimeline } from "./run-timeline";
import { StepInspector } from "./step-inspector";
import type { PlaygroundRunResult, TimelineFilter } from "./types";
import { getLoopCount, getToolCount } from "./trace-utils";

interface AgentSandboxProps {
  groups: GroupSummary[];
}

interface RunEntry {
  id: number;
  message: string;
  result: PlaygroundRunResult;
}

const FILTERS: TimelineFilter[] = ["all", "loop", "think", "tool"];

export function AgentSandbox({ groups }: AgentSandboxProps) {
  const [groupId, setGroupId] = useState(groups[0]?.groupId ?? "");
  const [senderName, setSenderName] = useState("测试用户");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [runs, setRuns] = useState<RunEntry[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [comparisonRunId, setComparisonRunId] = useState<number | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>("all");
  const [showRawThink, setShowRawThink] = useState(true);
  const [autoExpandLoops, setAutoExpandLoops] = useState(true);
  const [historyCompare, setHistoryCompare] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);
  const nextId = useRef(0);

  const activeRun = runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null;
  const comparisonRun = historyCompare
    ? runs.find((run) => run.id === comparisonRunId && run.id !== activeRun?.id) ?? null
    : null;
  const llmContext = activeRun?.result.llmContext;
  const selectedEvent =
    activeRun?.result.trace.events.find((event) => event.id === selectedEventId) ??
    activeRun?.result.trace.events[0] ??
    null;

  useEffect(() => {
    if (activeRun && !selectedEventId) {
      setSelectedEventId(activeRun.result.trace.events[0]?.id ?? null);
    }
  }, [activeRun, selectedEventId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = message.trim();
    if (!text || !groupId || loading) return;

    setLoading(true);
    setRequestError(null);

    try {
      const previousSelected = selectedRunId;
      const res = await fetch("/api/bot/api/playground/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId, message: text, senderName }),
      });
      const data: PlaygroundRunResult = await res.json();

      const nextRun: RunEntry = {
        id: nextId.current++,
        message: text,
        result: data,
      };

      setRuns((current) => [nextRun, ...current]);
      setSelectedRunId(nextRun.id);
      setSelectedEventId(data.trace.events[0]?.id ?? null);
      setComparisonRunId(historyCompare ? previousSelected : null);
      setMessage("");
    } catch (err) {
      setRequestError(`请求失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
  }

  return (
    <div className="flex flex-col gap-4 h-full">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-500 whitespace-nowrap">群组</label>
          <select
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          >
            {groups.map((g) => (
              <option key={g.groupId} value={g.groupId}>
                {g.groupName ?? g.groupId} ({g.groupId})
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-500 whitespace-nowrap">发送者</label>
          <input
            type="text"
            value={senderName}
            onChange={(e) => setSenderName(e.target.value)}
            placeholder="测试用户"
            className="h-8 w-32 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
        </div>

        <Toggle
          active={showRawThink}
          label="show raw think"
          onClick={() => setShowRawThink((value) => !value)}
        />
        <Toggle
          active={autoExpandLoops}
          label="auto-expand loops"
          onClick={() => setAutoExpandLoops((value) => !value)}
        />
        <Toggle
          active={historyCompare}
          label="history compare"
          onClick={() => {
            setHistoryCompare((value) => {
              const next = !value;
              if (!next) setComparisonRunId(null);
              return next;
            });
          }}
        />

        <div className="ml-auto flex flex-wrap gap-2">
          {FILTERS.map((filter) => (
            <button
              key={filter}
              type="button"
              onClick={() => setTimelineFilter(filter)}
              className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                timelineFilter === filter
                  ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                  : "border-slate-200 bg-white text-slate-500 hover:text-slate-700"
              }`}
            >
              {filter}
            </button>
          ))}
          {runs.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setRuns([]);
                setSelectedRunId(null);
                setComparisonRunId(null);
                setSelectedEventId(null);
              }}
              className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-500 hover:text-slate-700"
            >
              清空
            </button>
          )}
        </div>
      </div>

      <Card className="border-slate-200 bg-white">
        <CardContent className="p-4">
          <form onSubmit={handleSubmit} className="flex gap-2">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入消息… (Enter 发送，Shift+Enter 换行)"
              rows={2}
              disabled={loading}
              className="flex-1 resize-none rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:opacity-50"
            />
            <Button
              type="submit"
              disabled={loading || !message.trim() || !groupId}
              className="h-auto self-end bg-indigo-600 hover:bg-indigo-700 text-white px-3 cursor-pointer"
              size="sm"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </form>
          {requestError && <p className="mt-3 text-sm text-red-500">{requestError}</p>}
        </CardContent>
      </Card>

      {runs.length === 0 ? (
        <Card className="border-slate-200 bg-white flex-1">
          <CardContent className="flex min-h-[420px] items-center justify-center p-8 text-center text-slate-400">
            <div>
              <p className="text-sm">输入消息后会生成一条完整 run timeline。</p>
              <p className="mt-2 text-xs">你可以查看 phase、loop、tool、termination 和 recent runs 对比。</p>
            </div>
          </CardContent>
        </Card>
      ) : activeRun ? (
        <div className="grid flex-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <RecentRuns
            runs={runs}
            selectedRunId={activeRun.id}
            comparisonRunId={comparisonRunId}
            historyCompare={historyCompare}
            onSelectRun={(runId) => {
              setSelectedRunId(runId);
              const nextRun = runs.find((entry) => entry.id === runId);
              setSelectedEventId(nextRun?.result.trace.events[0]?.id ?? null);
            }}
            onSelectComparison={setComparisonRunId}
          />
          <div className="space-y-4">
            <Card className="border-slate-200 bg-white">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-slate-800">你发送的消息</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="whitespace-pre-wrap break-words text-sm text-slate-700">
                  {activeRun.message}
                </pre>
              </CardContent>
            </Card>

            <Card className="border-slate-200 bg-white">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-slate-800">完整 LLM 输入</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-slate-500">
                  这里展示首轮真正送进模型的内容，包括 system prompt、user message，以及这次可调用的工具。
                </p>

                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">System Prompt</p>
                  <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                    {llmContext?.systemPrompt ?? "当前返回里没有 system prompt。通常是 bot 后端还没重启到新版本。"}
                  </pre>
                </div>

                {(llmContext?.messages ?? []).map((msg, index) => (
                  <div key={`${msg.role}-${index}`} className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                      {msg.role === "user" ? "User Message" : msg.role}
                    </p>
                    <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                      {msg.content}
                    </pre>
                  </div>
                ))}

                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Available Tools</p>
                  <div className="flex flex-wrap gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                    {!llmContext ? (
                      <span className="text-sm text-slate-500">当前返回里没有工具列表</span>
                    ) : llmContext.tools.length === 0 ? (
                      <span className="text-sm text-slate-500">没有可调用工具</span>
                    ) : (
                      llmContext.tools.map((tool) => (
                        <span
                          key={tool}
                          className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600"
                        >
                          {tool}
                        </span>
                      ))
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-slate-200 bg-white">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-slate-800">输出结果</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2 text-xs text-slate-500">
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1">
                    状态 {activeRun.result.trace.finalState}
                  </span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1">
                    结束原因 {activeRun.result.trace.terminationReason}
                  </span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1">
                    {getLoopCount(activeRun.result.trace)} 轮
                  </span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1">
                    调用工具 {getToolCount(activeRun.result.trace)} 次
                  </span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1">
                    {(activeRun.result.elapsedMs / 1000).toFixed(1)}s
                  </span>
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Final Text</p>
                  <pre className="min-h-[120px] whitespace-pre-wrap break-words rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-800">
                    {activeRun.result.answer ?? activeRun.result.reason ?? "没有输出结果"}
                  </pre>
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Final Answer JSON</p>
                  <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                    {activeRun.result.finalAnswerPayload
                      ? JSON.stringify(activeRun.result.finalAnswerPayload, null, 2)
                      : "这次没有 final_answer JSON。"}
                  </pre>
                </div>
              </CardContent>
            </Card>

            <details className="rounded-xl border border-slate-200 bg-white">
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-slate-700">
                高级明细（可选）
              </summary>
              <div className="grid gap-4 border-t border-slate-200 p-4 xl:grid-cols-[minmax(0,1fr)_360px]">
                <RunTimeline
                  trace={activeRun.result.trace}
                  filter={timelineFilter}
                  selectedEventId={selectedEventId}
                  onSelectEvent={setSelectedEventId}
                  autoExpandLoops={autoExpandLoops}
                />
                <StepInspector
                  event={selectedEvent}
                  trace={activeRun.result.trace}
                  comparisonTrace={comparisonRun?.result.trace ?? null}
                  showRawThink={showRawThink}
                />
              </div>
            </details>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Toggle({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
        active
          ? "border-emerald-300 bg-emerald-50 text-emerald-700"
          : "border-slate-200 bg-white text-slate-500 hover:text-slate-700"
      }`}
    >
      {label}
    </button>
  );
}
