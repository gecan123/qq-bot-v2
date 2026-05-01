import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { Header } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import { getLlmTraceById, type TraceMessage } from "@/lib/runtime-queries";
import { formatDateTime } from "@/lib/format-time";
import { compactId } from "@/lib/runtime-format";

interface Props {
  params: Promise<{ sceneId: string; traceId: string }>;
}

const MARKER_STYLES: Record<TraceMessage["marker"], { wrap: string; chip: string; chipText: string }> = {
  summary_head: {
    wrap: "border-emerald-300 bg-emerald-50/40",
    chip: "bg-emerald-100 text-emerald-800",
    chipText: "summary head · 稳定前缀",
  },
  trigger: {
    wrap: "border-amber-300 bg-amber-50/40",
    chip: "bg-amber-100 text-amber-800",
    chipText: "trigger · 当前消息",
  },
  quoted: {
    wrap: "border-violet-300 bg-violet-50/40",
    chip: "bg-violet-100 text-violet-800",
    chipText: "quoted · 被引用消息",
  },
  window: { wrap: "border-slate-200 bg-white", chip: "bg-slate-100 text-slate-700", chipText: "window" },
  raw: { wrap: "border-slate-200 bg-slate-50", chip: "bg-slate-100 text-slate-500", chipText: "raw" },
};

const ROLE_BADGE: Record<TraceMessage["role"], string> = {
  user: "bg-slate-200 text-slate-800",
  model: "bg-sky-100 text-sky-800",
  tool_calls: "bg-orange-100 text-orange-800",
  tool_results: "bg-orange-100 text-orange-800",
  unknown: "bg-slate-100 text-slate-500",
};

function MessageCard({ message, index }: { message: TraceMessage; index: number }) {
  const style = MARKER_STYLES[message.marker];
  const roleBadge = ROLE_BADGE[message.role];
  return (
    <div className={`rounded-md border ${style.wrap} p-3`}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono text-slate-400">#{index}</span>
        <span className={`rounded-full px-2 py-0.5 font-medium ${roleBadge}`}>{message.role}</span>
        <span className={`rounded-full px-2 py-0.5 ${style.chip}`}>{style.chipText}</span>
        <span className="ml-auto font-mono text-slate-400">{message.content.length} chars</span>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-800">
        {message.content}
      </pre>
    </div>
  );
}

function TokenBar({
  inputTokens,
  cachedTokens,
}: {
  inputTokens: number | null;
  cachedTokens: number | null;
}) {
  const input = inputTokens ?? 0;
  const cached = cachedTokens ?? 0;
  if (input === 0) {
    return <div className="text-xs text-slate-400">无 input token 数据</div>;
  }
  const cachedRatio = Math.min(1, cached / input);
  const newRatio = 1 - cachedRatio;
  return (
    <div className="grid gap-1.5">
      <div className="flex h-3 overflow-hidden rounded bg-slate-100">
        <div
          className="bg-emerald-500"
          style={{ width: `${cachedRatio * 100}%` }}
          title={`cached ${cached.toLocaleString()} tokens (${(cachedRatio * 100).toFixed(1)}%)`}
        />
        <div
          className="bg-amber-400"
          style={{ width: `${newRatio * 100}%` }}
          title={`new ${(input - cached).toLocaleString()} tokens (${(newRatio * 100).toFixed(1)}%)`}
        />
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-slate-600">
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded bg-emerald-500" />
          cached {cached.toLocaleString()} ({(cachedRatio * 100).toFixed(1)}%)
        </span>
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded bg-amber-400" />
          new {(input - cached).toLocaleString()} ({(newRatio * 100).toFixed(1)}%)
        </span>
        <span className="ml-auto font-mono text-slate-400">total {input.toLocaleString()}</span>
      </div>
    </div>
  );
}

export default async function LlmTraceDetailPage({ params }: Props) {
  const { sceneId: rawSceneId, traceId: rawTraceId } = await params;
  const sceneId = decodeURIComponent(rawSceneId);
  const traceId = Number.parseInt(rawTraceId, 10);
  if (Number.isNaN(traceId)) notFound();
  const trace = await getLlmTraceById(traceId);
  if (!trace) notFound();

  return (
    <>
      <nav className="mb-5 flex items-center gap-1.5 text-xs text-slate-400">
        <Link href="/llm-traces" className="hover:text-slate-600">LLM Trace 观测</Link>
        <ChevronRight className="h-3 w-3" />
        <Link href={`/llm-traces/${encodeURIComponent(sceneId)}`} className="font-mono hover:text-slate-600">
          {sceneId}
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="font-mono text-slate-600">#{trace.id}</span>
      </nav>

      <Header
        title={`Trace #${trace.id}`}
        description={`${formatDateTime(trace.createdAt)} · ${trace.model ?? "unknown model"} · ${trace.durationMs}ms${trace.error ? " · ERROR" : ""}`}
      />

      {trace.error && (
        <Card className="mb-4 border-rose-300 bg-rose-50">
          <CardContent className="p-4 text-sm text-rose-900">
            <div className="mb-1 font-semibold">运行时错误</div>
            <pre className="overflow-x-auto whitespace-pre-wrap text-xs">{trace.error}</pre>
          </CardContent>
        </Card>
      )}

      {/* Token breakdown */}
      <Card className="mb-4 border-slate-200 bg-white">
        <CardContent className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Token breakdown</h2>
            <span
              className={
                trace.tokenUsageState === "captured"
                  ? "rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700"
                  : trace.tokenUsageState === "unavailable"
                    ? "rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700"
                    : "rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
              }
            >
              {trace.tokenUsageState ?? "—"}
            </span>
          </div>
          <TokenBar inputTokens={trace.inputTokens} cachedTokens={trace.cachedTokens} />
          <div className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-4">
            <div>
              <div className="text-slate-400">output</div>
              <div className="mt-0.5 font-mono">{trace.outputTokens?.toLocaleString() ?? "—"}</div>
            </div>
            <div>
              <div className="text-slate-400">prefix hash</div>
              <div className="mt-0.5 font-mono" title={trace.prefixHash ?? ""}>
                {trace.prefixHash ? compactId(trace.prefixHash, 12) : "—"}
              </div>
            </div>
            <div>
              <div className="text-slate-400">tail hash</div>
              <div className="mt-0.5 font-mono" title={trace.tailHash ?? ""}>
                {trace.tailHash ? compactId(trace.tailHash, 12) : "—"}
              </div>
            </div>
            <div>
              <div className="text-slate-400">input hash</div>
              <div className="mt-0.5 font-mono" title={trace.inputHash ?? ""}>
                {trace.inputHash ? compactId(trace.inputHash, 12) : "—"}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* System prompt (折叠默认) */}
      <details className="mb-4">
        <summary className="cursor-pointer rounded-md border border-slate-200 bg-white p-3 text-sm font-medium text-slate-700">
          System prompt ({trace.systemPrompt.length} chars)
        </summary>
        <Card className="mt-2 border-slate-200 bg-slate-50">
          <CardContent className="p-4">
            <pre className="overflow-x-auto whitespace-pre-wrap text-xs leading-relaxed text-slate-700">
              {trace.systemPrompt}
            </pre>
          </CardContent>
        </Card>
      </details>

      {/* Prefix segment */}
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-slate-900">稳定前缀 (prefix)</h2>
        <span className="text-xs text-slate-400">prefixHash 算这段 + system</span>
      </div>
      {trace.prefixMessages.length === 0 ? (
        <Card className="mb-4 border-dashed border-slate-300 bg-slate-50">
          <CardContent className="p-3 text-xs text-slate-400">无 summary head (无 compaction 摘要)</CardContent>
        </Card>
      ) : (
        <div className="mb-4 grid gap-2">
          {trace.prefixMessages.map((message, index) => (
            <MessageCard key={`prefix-${index}`} message={message} index={index} />
          ))}
        </div>
      )}

      {/* Tail segment */}
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-slate-900">易变尾部 (tail)</h2>
        <span className="text-xs text-slate-400">tailHash 算这段 · window history + trigger</span>
      </div>
      {trace.tailMessages.length === 0 ? (
        <Card className="mb-4 border-dashed border-slate-300 bg-slate-50">
          <CardContent className="p-3 text-xs text-slate-400">无 tail (异常)</CardContent>
        </Card>
      ) : (
        <div className="mb-4 grid gap-2">
          {trace.tailMessages.map((message, index) => (
            <MessageCard
              key={`tail-${index}`}
              message={message}
              index={trace.prefixMessages.length + index}
            />
          ))}
        </div>
      )}

      {/* Output (model 回的最终文本 / tool calls) */}
      {trace.outputPreview && (
        <details className="mb-4">
          <summary className="cursor-pointer rounded-md border border-slate-200 bg-white p-3 text-sm font-medium text-slate-700">
            Output ({trace.outputPreview.length} chars)
          </summary>
          <Card className="mt-2 border-slate-200 bg-sky-50/40">
            <CardContent className="p-4">
              <pre className="overflow-x-auto whitespace-pre-wrap text-xs leading-relaxed text-slate-800">
                {trace.outputPreview}
              </pre>
            </CardContent>
          </Card>
        </details>
      )}
    </>
  );
}
