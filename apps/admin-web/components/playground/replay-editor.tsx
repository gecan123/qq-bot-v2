"use client";

import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PlaygroundRunResult, ReplayMessage, ReplayPayload } from "./types";

interface ReplayEditorProps {
  payload: ReplayPayload;
  onRun: (nextPayload: ReplayPayload) => Promise<PlaygroundRunResult>;
  compact?: boolean;
}

function parseHistory(raw: string): { value?: ReplayMessage[]; error?: string } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return { error: "history 必须是数组" };
    }
    const messages: ReplayMessage[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") {
        return { error: "history 每一项必须是对象" };
      }
      const role = (item as { role?: unknown }).role;
      const content = (item as { content?: unknown }).content;
      if (typeof role !== "string" || !role.trim()) {
        return { error: "history.role 必须是非空字符串" };
      }
      if (typeof content !== "string") {
        return { error: "history.content 必须是字符串" };
      }
      messages.push({ role: role.trim(), content });
    }
    if (messages.length === 0) {
      return { error: "history 至少保留一条消息" };
    }
    return { value: messages };
  } catch (err) {
    return { error: `history JSON 解析失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function parseTools(raw: string): { value?: string[]; error?: string } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return { error: "tools 必须是字符串数组" };
    }
    const tools: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string" || !item.trim()) {
        return { error: "tools 中每一项都必须是非空字符串" };
      }
      tools.push(item.trim());
    }
    const uniq = Array.from(new Set(tools));
    return { value: uniq };
  } catch (err) {
    return { error: `tools JSON 解析失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function ReplayEditor({ payload, onRun, compact = false }: ReplayEditorProps) {
  const [model, setModel] = useState(payload.model);
  const [systemPrompt, setSystemPrompt] = useState(payload.systemPrompt);
  const [historyText, setHistoryText] = useState(JSON.stringify(payload.history, null, 2));
  const [toolsText, setToolsText] = useState(JSON.stringify(payload.tools, null, 2));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PlaygroundRunResult | null>(null);

  const parsed = useMemo(() => {
    const history = parseHistory(historyText);
    if (history.error) return { error: history.error };

    const tools = parseTools(toolsText);
    if (tools.error) return { error: tools.error };

    return {
      value: {
        ...payload,
        model: model.trim() || payload.model,
        systemPrompt,
        history: history.value!,
        tools: tools.value!,
      } satisfies ReplayPayload,
    };
  }, [historyText, model, payload, systemPrompt, toolsText]);

  async function handleRun() {
    if (!parsed.value) {
      setError(parsed.error ?? "输入不合法");
      return;
    }
    if (!parsed.value.systemPrompt.trim()) {
      setError("systemPrompt 不能为空");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const next = await onRun(parsed.value);
      setResult(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function handleReset() {
    setModel(payload.model);
    setSystemPrompt(payload.systemPrompt);
    setHistoryText(JSON.stringify(payload.history, null, 2));
    setToolsText(JSON.stringify(payload.tools, null, 2));
    setError(null);
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-slate-500">
          model
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="mt-1 h-9 w-full rounded-md border border-slate-200 px-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </label>
        <label className="text-xs text-slate-500">
          groupId (只读)
          <input
            type="text"
            value={payload.groupId}
            readOnly
            className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-slate-50 px-2 text-sm text-slate-500"
          />
        </label>
      </div>

      <label className="block text-xs text-slate-500">
        systemPrompt
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={compact ? 8 : 12}
          className="mt-1 w-full resize-y rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </label>

      <label className="block text-xs text-slate-500">
        history (JSON)
        <textarea
          value={historyText}
          onChange={(e) => setHistoryText(e.target.value)}
          rows={compact ? 10 : 14}
          className="mt-1 w-full resize-y rounded-md border border-slate-200 px-3 py-2 font-mono text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </label>

      <label className="block text-xs text-slate-500">
        tools (JSON string[])
        <textarea
          value={toolsText}
          onChange={(e) => setToolsText(e.target.value)}
          rows={compact ? 5 : 7}
          className="mt-1 w-full resize-y rounded-md border border-slate-200 px-3 py-2 font-mono text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </label>

      {payload.meta.toolsSource === "dynamic" && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          该 trace 未记录原始 tools，本次使用当前系统动态工具列表作为初始值。
        </p>
      )}

      {(error || parsed.error) && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
          {error ?? parsed.error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          onClick={handleRun}
          disabled={loading || !!parsed.error || !systemPrompt.trim()}
          className="bg-indigo-600 hover:bg-indigo-700 text-white"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Run Strict Replay
        </Button>
        <Button type="button" variant="outline" onClick={handleReset} disabled={loading}>
          Reset to Original
        </Button>
      </div>

      {result && (
        <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <p className="text-xs text-slate-500">
            状态 {result.state} · 耗时 {(result.elapsedMs / 1000).toFixed(2)}s · 结束原因 {result.trace.terminationReason}
          </p>
          <pre className="whitespace-pre-wrap break-words text-sm text-slate-800">
            {result.answer ?? result.reason ?? "没有输出"}
          </pre>
        </div>
      )}
    </div>
  );
}
