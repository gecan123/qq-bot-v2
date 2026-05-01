import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight, CheckCircle2, XCircle } from "lucide-react";
import { Header } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TokenTimelineChart } from "@/components/runtime/token-timeline-chart";
import { getLlmTraceSceneDetail } from "@/lib/runtime-queries";
import { formatDateTime } from "@/lib/format-time";
import { compactId } from "@/lib/runtime-format";

interface Props {
  params: Promise<{ sceneId: string }>;
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function VerdictRow({
  ok,
  label,
  detail,
}: {
  ok: boolean;
  label: string;
  detail: string;
}) {
  return (
    <div className="flex items-start gap-3">
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
      ) : (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />
      )}
      <div className="min-w-0">
        <div className="text-sm font-medium text-slate-900">{label}</div>
        <div className="mt-0.5 text-xs text-slate-500">{detail}</div>
      </div>
    </div>
  );
}

export default async function LlmTraceSceneDetailPage({ params }: Props) {
  const { sceneId: rawSceneId } = await params;
  const sceneId = decodeURIComponent(rawSceneId);
  const detail = await getLlmTraceSceneDetail(sceneId);
  if (!detail) notFound();

  const { summary, recentCalls, verdict } = detail;
  const allThreePass = verdict.prefixStable && verdict.cacheHit && verdict.captured;

  return (
    <>
      <nav className="mb-5 flex items-center gap-1.5 text-xs text-slate-400">
        <Link href="/llm-traces" className="hover:text-slate-600">
          LLM Trace 观测
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="font-mono text-slate-600">{sceneId}</span>
      </nav>

      <Header
        title={sceneId}
        description={`最近 ${summary.callCount} 次调用 · ${formatDateTime(summary.lastCallAt)}`}
      />

      <Card className="mb-6 border-slate-200 bg-white">
        <CardContent className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">P0 验证三件套</h2>
            <span
              className={
                allThreePass
                  ? "rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700"
                  : "rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700"
              }
            >
              {allThreePass ? "全部通过" : "未全部通过"}
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <VerdictRow
              ok={verdict.prefixStable}
              label="Prefix 稳定"
              detail={`unique prefix hashes = ${summary.uniquePrefixHashes} (≤ 2 视为稳定, 允许一次 compaction)`}
            />
            <VerdictRow
              ok={verdict.cacheHit}
              label="Cache 命中"
              detail={`${summary.cacheHitCount}/${summary.callCount} 次命中 · 累计 cached ${summary.totalCachedTokens.toLocaleString()} tokens`}
            />
            <VerdictRow
              ok={verdict.captured}
              label="Token usage captured"
              detail={`captured 调用 ${summary.capturedCount}/${summary.callCount} (provider 真返回了 cache 字段)`}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="mb-6 border-slate-200 bg-white">
        <CardContent className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Token timeline</h2>
            <span className="text-xs text-slate-400">最近 {recentCalls.length} 次, 时间正序</span>
          </div>
          <TokenTimelineChart
            points={[...recentCalls].reverse().map((call) => ({
              createdAt: call.createdAt,
              inputTokens: call.inputTokens,
              cachedTokens: call.cachedTokens,
              prefixHash: call.prefixHash,
            }))}
          />
        </CardContent>
      </Card>

      <Card className="mb-6 border-slate-200 bg-white">
        <CardContent className="grid gap-2 p-4 text-xs text-slate-600 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="text-slate-400">Cached / Input tokens</div>
            <div className="mt-0.5 font-mono text-sm text-slate-800">
              {summary.totalCachedTokens.toLocaleString()} / {summary.totalInputTokens.toLocaleString()}
            </div>
          </div>
          <div>
            <div className="text-slate-400">Cached %</div>
            <div className="mt-0.5 font-mono text-sm text-slate-800">{formatPercent(summary.avgCacheHitRatio)}</div>
          </div>
          <div>
            <div className="text-slate-400">调用总数</div>
            <div className="mt-0.5 font-mono text-sm text-slate-800">{summary.callCount}</div>
          </div>
          <div>
            <div className="text-slate-400">Unique prefixes</div>
            <div className="mt-0.5 font-mono text-sm text-slate-800">{summary.uniquePrefixHashes}</div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-slate-200 bg-white">
        <CardContent className="p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">最近 {recentCalls.length} 次调用</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">时间</TableHead>
                <TableHead>Prefix hash</TableHead>
                <TableHead className="text-right">Loop</TableHead>
                <TableHead className="text-right">Input</TableHead>
                <TableHead className="text-right">Cached</TableHead>
                <TableHead className="text-right">Output</TableHead>
                <TableHead className="text-right">Hit %</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentCalls.map((call, index) => {
                const prevPrefix = recentCalls[index + 1]?.prefixHash ?? null;
                const prefixChanged = prevPrefix !== null && call.prefixHash !== prevPrefix;
                const hitRatio = call.inputTokens && call.inputTokens > 0
                  ? (call.cachedTokens ?? 0) / call.inputTokens
                  : 0;
                return (
                  <TableRow key={call.id}>
                    <TableCell className="whitespace-nowrap text-xs text-slate-500">
                      <Link
                        href={`/llm-traces/${encodeURIComponent(sceneId)}/${call.id}`}
                        className="text-indigo-600 hover:underline"
                      >
                        {formatDateTime(call.createdAt)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span
                        className={
                          prefixChanged
                            ? "font-mono text-xs text-amber-600"
                            : "font-mono text-xs text-slate-600"
                        }
                        title={prefixChanged ? "前缀切换 (compaction 或拼装变化)" : ""}
                      >
                        {call.prefixHash ? compactId(call.prefixHash, 12) : "—"}
                      </span>
                    </TableCell>
                    <TableCell className="text-right text-xs text-slate-600">
                      {call.loopIndex ?? "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">{call.inputTokens ?? "—"}</TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      <span className={(call.cachedTokens ?? 0) > 0 ? "text-emerald-700 font-medium" : "text-slate-400"}>
                        {call.cachedTokens ?? "—"}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">{call.outputTokens ?? "—"}</TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      <span className={hitRatio > 0 ? "text-emerald-700" : "text-slate-400"}>
                        {formatPercent(hitRatio)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span
                        className={
                          call.tokenUsageState === "captured"
                            ? "rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700"
                            : call.tokenUsageState === "unavailable"
                              ? "rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700"
                              : "rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
                        }
                      >
                        {call.tokenUsageState ?? "—"}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-slate-500">{call.model ?? "—"}</TableCell>
                    <TableCell className="text-right text-xs text-slate-500">{call.durationMs}ms</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
