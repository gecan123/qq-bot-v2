import Link from "next/link";
import { Header } from "@/components/layout/header";
import { EmptyState } from "@/components/runtime/empty-state";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getLlmTraceSceneList } from "@/lib/runtime-queries";
import { formatDateTime } from "@/lib/format-time";

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export default async function LlmTracesPage() {
  const scenes = await getLlmTraceSceneList();

  return (
    <>
      <Header
        title="LLM Trace 观测"
        description={`最近 7 天 ${scenes.length} 个 scene 有 LLM 调用 · Phase 1.5 永续上下文 cache 命中观测`}
      />

      <Card className="mb-6 border-slate-200 bg-white">
        <CardContent className="grid gap-2 p-4 text-xs text-slate-600">
          <div>
            <span className="font-semibold text-slate-700">P0 验证三件套</span>:
            点进单个 scene 看 prefix_hash 是否稳定 (除 compaction 之外不变)、cached_tokens 第二次起非零、token_usage_state 为 captured。
          </div>
          <div>
            如果 cache hit ratio 长期为 0%，按 <span className="font-mono">docs/perpetual-context-phase1.5-observation.zh-CN.md</span> 排查 cheatsheet。
          </div>
        </CardContent>
      </Card>

      {scenes.length === 0 ? (
        <EmptyState>最近 7 天没有 LLM 调用记录</EmptyState>
      ) : (
        <Card className="border-slate-200 bg-white">
          <CardContent className="p-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Scene</TableHead>
                  <TableHead className="text-right">调用次数</TableHead>
                  <TableHead className="text-right">Cache 命中</TableHead>
                  <TableHead className="text-right">Cached / Input tokens</TableHead>
                  <TableHead className="text-right">Cached %</TableHead>
                  <TableHead className="text-right">Prefix 数</TableHead>
                  <TableHead className="text-right">Captured 调用</TableHead>
                  <TableHead className="whitespace-nowrap">最近一次</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scenes.map((scene) => {
                  const cacheHitRatio = scene.callCount === 0 ? 0 : scene.cacheHitCount / scene.callCount;
                  const stable = scene.uniquePrefixHashes > 0 && scene.uniquePrefixHashes <= 2;
                  return (
                    <TableRow key={scene.sceneId}>
                      <TableCell>
                        <Link
                          href={`/llm-traces/${encodeURIComponent(scene.sceneId)}`}
                          className="font-mono text-xs text-indigo-600 hover:underline"
                        >
                          {scene.sceneId}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right">{scene.callCount}</TableCell>
                      <TableCell className="text-right">
                        <span className={cacheHitRatio > 0 ? "text-emerald-700" : "text-slate-400"}>
                          {scene.cacheHitCount} / {scene.callCount}
                        </span>
                      </TableCell>
                      <TableCell className="text-right text-xs text-slate-600">
                        {scene.totalCachedTokens.toLocaleString()} / {scene.totalInputTokens.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <span className={scene.avgCacheHitRatio > 0 ? "text-emerald-700 font-medium" : "text-slate-400"}>
                          {formatPercent(scene.avgCacheHitRatio)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className={stable ? "text-emerald-700" : "text-amber-600"}>
                          {scene.uniquePrefixHashes}
                        </span>
                      </TableCell>
                      <TableCell className="text-right text-xs text-slate-600">
                        {scene.capturedCount} / {scene.callCount}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-slate-500">
                        {formatDateTime(scene.lastCallAt)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  );
}
