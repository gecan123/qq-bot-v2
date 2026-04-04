"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Loader2, Bot, User, AlertCircle, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ToolCallTrace, type PlaygroundStep } from "./tool-call-card";
import type { GroupSummary } from "@/lib/queries";

interface RunResult {
  state: "final" | "fallback" | "aborted";
  answer?: string;
  reason?: string;
  steps: PlaygroundStep[];
  elapsedMs: number;
}

interface ChatEntry {
  id: number;
  role: "user" | "bot";
  content: string;
  steps?: PlaygroundStep[];
  state?: RunResult["state"];
  reason?: string;
  elapsedMs?: number;
}

interface AgentSandboxProps {
  groups: GroupSummary[];
}

export function AgentSandbox({ groups }: AgentSandboxProps) {
  const [groupId, setGroupId] = useState(groups[0]?.groupId ?? "");
  const [senderName, setSenderName] = useState("测试用户");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<ChatEntry[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(0);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history, loading]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = message.trim();
    if (!text || !groupId || loading) return;

    const userEntry: ChatEntry = { id: nextId.current++, role: "user", content: text };
    setHistory((h) => [...h, userEntry]);
    setMessage("");
    setLoading(true);

    try {
      const res = await fetch("/api/bot/api/playground/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId, message: text, senderName }),
      });
      const data: RunResult = await res.json();

      const botEntry: ChatEntry = {
        id: nextId.current++,
        role: "bot",
        content: data.answer ?? data.reason ?? `状态: ${data.state}`,
        steps: data.steps,
        state: data.state,
        reason: data.reason,
        elapsedMs: data.elapsedMs,
      };
      setHistory((h) => [...h, botEntry]);
    } catch (err) {
      const errEntry: ChatEntry = {
        id: nextId.current++,
        role: "bot",
        content: `请求失败: ${err instanceof Error ? err.message : String(err)}`,
        state: "fallback",
      };
      setHistory((h) => [...h, errEntry]);
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

  const selectedGroup = groups.find((g) => g.groupId === groupId);

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* Config bar */}
      <div className="flex items-center gap-3 flex-wrap">
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
        {selectedGroup && (
          <span className="text-xs text-slate-400 ml-auto">
            上下文来自真实群消息 · 不会发送到 QQ
          </span>
        )}
        {history.length > 0 && (
          <button
            onClick={() => setHistory([])}
            className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
          >
            清空
          </button>
        )}
      </div>

      {/* Chat area */}
      <Card className="bg-white border-slate-200 flex-1">
        <CardContent className="p-4 flex flex-col h-full min-h-[500px]">
          <div className="flex-1 overflow-y-auto space-y-4 pb-2">
            {history.length === 0 && (
              <div className="flex flex-col items-center justify-center h-48 text-slate-400">
                <Bot className="h-8 w-8 mb-2 opacity-30" />
                <p className="text-sm">输入消息，模拟 @bot 的完整 agent 回复流程</p>
                <p className="text-xs mt-1 opacity-70">使用真实群聊记忆和数据库工具，但不发送到 QQ</p>
              </div>
            )}

            {history.map((entry) => (
              <div key={entry.id} className={`flex gap-3 ${entry.role === "user" ? "flex-row-reverse" : ""}`}>
                <div
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold mt-0.5 ${
                    entry.role === "user"
                      ? "bg-indigo-100 text-indigo-600"
                      : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {entry.role === "user" ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
                </div>

                <div className={`flex-1 min-w-0 ${entry.role === "user" ? "items-end" : "items-start"} flex flex-col`}>
                  {entry.role === "bot" && entry.steps && entry.steps.length > 0 && (
                    <ToolCallTrace steps={entry.steps} />
                  )}

                  <div
                    className={`max-w-prose rounded-xl px-3.5 py-2.5 text-sm leading-relaxed ${
                      entry.role === "user"
                        ? "bg-indigo-50 text-indigo-900 rounded-tr-sm"
                        : entry.state === "final"
                        ? "bg-slate-100 text-slate-800 rounded-tl-sm"
                        : "bg-red-50 text-red-700 rounded-tl-sm border border-red-100"
                    }`}
                  >
                    {entry.state !== "final" && entry.role === "bot" && (
                      <span className="flex items-center gap-1 text-xs text-red-500 mb-1">
                        <AlertCircle className="h-3 w-3" />
                        {entry.state}
                      </span>
                    )}
                    <p className="whitespace-pre-wrap">{entry.content}</p>
                  </div>

                  {entry.elapsedMs != null && (
                    <p className="flex items-center gap-1 text-xs text-slate-400 mt-1">
                      <Clock className="h-3 w-3" />
                      {(entry.elapsedMs / 1000).toFixed(1)}s
                    </p>
                  )}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex gap-3">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-400">
                  <Bot className="h-3.5 w-3.5" />
                </div>
                <div className="flex items-center gap-2 text-sm text-slate-400 bg-slate-100 rounded-xl rounded-tl-sm px-3.5 py-2.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Agent 思考中…
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <form onSubmit={handleSubmit} className="flex gap-2 mt-3 pt-3 border-t border-slate-100">
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
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
