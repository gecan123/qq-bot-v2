"use client";

import Link from "next/link";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format-time";
import { ReplayEditor } from "@/components/playground/replay-editor";
import type { PlaygroundRunResult, ReplayPayload } from "@/components/playground/types";

export interface TraceRow {
  id: number;
  groupId: string;
  model: string | null;
  durationMs: number;
  error: string | null;
  createdAt: string;
  systemPromptPreview: string;
  historyCount: number;
}

interface TraceTableProps {
  items: TraceRow[];
}

export function TraceTable({ items }: TraceTableProps) {
  const [quickDebugTraceId, setQuickDebugTraceId] = useState<number | null>(null);
  const [loadingPayload, setLoadingPayload] = useState(false);
  const [payloadError, setPayloadError] = useState<string | null>(null);
  const [payload, setPayload] = useState<ReplayPayload | null>(null);

  async function openQuickDebug(traceId: number) {
    setQuickDebugTraceId(traceId);
    setPayload(null);
    setPayloadError(null);
    setLoadingPayload(true);

    try {
      const res = await fetch(`/api/bot/api/playground/trace/${traceId}`);
      const data = (await res.json()) as ReplayPayload | { error: string };
      if (!res.ok) {
        throw new Error("error" in data ? data.error : `请求失败(${res.status})`);
      }
      setPayload(data as ReplayPayload);
    } catch (err) {
      setPayloadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingPayload(false);
    }
  }

  async function runReplay(nextPayload: ReplayPayload): Promise<PlaygroundRunResult> {
    const res = await fetch("/api/bot/api/playground/replay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nextPayload),
    });

    const data = (await res.json()) as PlaygroundRunResult | { error: string };
    if (!res.ok) {
      throw new Error("error" in data ? data.error : `请求失败(${res.status})`);
    }
    return data as PlaygroundRunResult;
  }

  return (
    <>
      <Card className="border-slate-200 bg-white">
        <CardHeader>
          <CardTitle className="text-base text-slate-800">LLM Traces</CardTitle>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <p className="text-sm text-slate-400">暂无 trace 数据。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[80px]">ID</TableHead>
                  <TableHead className="w-[120px]">Group</TableHead>
                  <TableHead className="w-[120px]">Model</TableHead>
                  <TableHead>System Prompt 预览</TableHead>
                  <TableHead className="w-[90px]">History</TableHead>
                  <TableHead className="w-[90px]">耗时</TableHead>
                  <TableHead className="w-[160px]">时间</TableHead>
                  <TableHead className="w-[200px] text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id} className={item.error ? "bg-red-50/40" : undefined}>
                    <TableCell className="font-mono text-xs">#{item.id}</TableCell>
                    <TableCell className="font-mono text-xs">{item.groupId}</TableCell>
                    <TableCell className="text-xs text-slate-600">{item.model ?? "-"}</TableCell>
                    <TableCell className="text-xs text-slate-600">
                      <p className="line-clamp-2">{item.systemPromptPreview || "(空)"}</p>
                      {item.error && <p className="mt-1 text-red-500 line-clamp-1">{item.error}</p>}
                    </TableCell>
                    <TableCell className="text-xs text-slate-500">{item.historyCount}</TableCell>
                    <TableCell className="text-xs text-slate-500">{item.durationMs}ms</TableCell>
                    <TableCell className="text-xs text-slate-500">{formatDateTime(item.createdAt)}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button asChild size="sm" variant="outline">
                          <Link href={`/playground?replayTraceId=${item.id}`}>Debug</Link>
                        </Button>
                        <Button size="sm" onClick={() => openQuickDebug(item.id)}>
                          Quick Debug
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {quickDebugTraceId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 px-4">
          <div className="max-h-[92vh] w-full max-w-5xl overflow-auto rounded-xl bg-white shadow-xl">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-5 py-3">
              <p className="text-sm font-semibold text-slate-800">Quick Debug · Trace #{quickDebugTraceId}</p>
              <button
                type="button"
                onClick={() => setQuickDebugTraceId(null)}
                className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
              >
                关闭
              </button>
            </div>
            <div className="p-5">
              {loadingPayload ? (
                <div className="flex h-40 items-center justify-center text-slate-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="ml-2 text-sm">加载 trace...</span>
                </div>
              ) : payloadError ? (
                <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                  {payloadError}
                </p>
              ) : payload ? (
                <ReplayEditor payload={payload} onRun={runReplay} compact />
              ) : null}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
