"use client";

import { Clock3, Gauge, GitCompareArrows } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { PlaygroundRunResult } from "./types";
import { getLoopCount, getToolCount } from "./trace-utils";

interface RecentRunItem {
  id: number;
  message: string;
  result: PlaygroundRunResult;
}

interface RecentRunsProps {
  runs: RecentRunItem[];
  selectedRunId: number | null;
  comparisonRunId: number | null;
  historyCompare: boolean;
  onSelectRun: (runId: number) => void;
  onSelectComparison: (runId: number | null) => void;
}

export function RecentRuns({
  runs,
  selectedRunId,
  comparisonRunId,
  historyCompare,
  onSelectRun,
  onSelectComparison,
}: RecentRunsProps) {
  return (
    <Card className="border-slate-200 bg-white">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold text-slate-800">最近几次运行</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {runs.length === 0 ? (
          <p className="text-sm text-slate-400">还没有 playground run。</p>
        ) : (
          runs.map((run) => {
            const selected = run.id === selectedRunId;
            const comparing = run.id === comparisonRunId;

            return (
              <button
                key={run.id}
                type="button"
                onClick={() => onSelectRun(run.id)}
                className={cn(
                  "w-full rounded-xl border px-3 py-3 text-left transition-colors",
                  selected
                    ? "border-indigo-300 bg-indigo-50"
                    : "border-slate-200 bg-slate-50 hover:border-slate-300 hover:bg-slate-100",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-800">{run.message}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          {run.result.state === "final"
                        ? run.result.trace.finalAnswer ?? "已成功结束"
                        : run.result.reason ?? run.result.state}
                    </p>
                  </div>
                  {historyCompare && (
                    <span
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelectComparison(comparing ? null : run.id);
                      }}
                      className={cn(
                        "inline-flex h-7 w-7 items-center justify-center rounded-md border",
                        comparing
                          ? "border-amber-300 bg-amber-50 text-amber-700"
                          : "border-slate-200 bg-white text-slate-400 hover:text-slate-600",
                      )}
                    >
                      <GitCompareArrows className="h-3.5 w-3.5" />
                    </span>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-500">
                  <span className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-1">
                    <Gauge className="h-3 w-3" />
                    {getLoopCount(run.result.trace)} 轮
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-1">
                    调用工具 {getToolCount(run.result.trace)} 次
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-1">
                    <Clock3 className="h-3 w-3" />
                    {(run.result.elapsedMs / 1000).toFixed(1)}s
                  </span>
                </div>
              </button>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
