"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Database, Globe, Cpu } from "lucide-react";

export interface PlaygroundStep {
  type: "tool_call" | "tool_result";
  name: string;
  input?: unknown;
  output?: string;
  error?: string;
  durationMs?: number;
}

function ToolIcon({ name }: { name: string }) {
  if (name === "db_read" || name === "db_schema") return <Database className="h-3 w-3" />;
  if (name === "web_search") return <Globe className="h-3 w-3" />;
  return <Cpu className="h-3 w-3" />;
}

function truncate(str: string, max: number) {
  return str.length > max ? str.slice(0, max) + "…" : str;
}

interface ToolCallPairProps {
  call: PlaygroundStep;
  result: PlaygroundStep | undefined;
}

export function ToolCallPair({ call, result }: ToolCallPairProps) {
  const [open, setOpen] = useState(false);

  const isError = !!result?.error;
  const durationText = result?.durationMs != null ? `${result.durationMs}ms` : null;

  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 text-xs overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-100 transition-colors"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-slate-400" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-slate-400" />
        )}
        <span className="flex items-center gap-1.5 text-slate-600 font-mono font-medium">
          <ToolIcon name={call.name} />
          {call.name}
        </span>
        {durationText && (
          <span className={`ml-auto font-mono ${isError ? "text-red-400" : "text-slate-400"}`}>
            {isError ? "error · " : ""}{durationText}
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-slate-200 divide-y divide-slate-100">
          {call.input !== undefined && (
            <div className="px-3 py-2">
              <p className="text-slate-400 mb-1 uppercase tracking-wider" style={{ fontSize: "10px" }}>Input</p>
              <pre className="text-slate-600 overflow-x-auto whitespace-pre-wrap break-words">
                {truncate(JSON.stringify(call.input, null, 2), 1200)}
              </pre>
            </div>
          )}
          {result && (
            <div className="px-3 py-2">
              <p className="text-slate-400 mb-1 uppercase tracking-wider" style={{ fontSize: "10px" }}>
                {isError ? "Error" : "Output"}
              </p>
              <pre className={`overflow-x-auto whitespace-pre-wrap break-words ${isError ? "text-red-500" : "text-slate-600"}`}>
                {truncate(result.error ?? result.output ?? "", 2000)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ToolCallTrace({ steps }: { steps: PlaygroundStep[] }) {
  const pairs: { call: PlaygroundStep; result: PlaygroundStep | undefined }[] = [];

  let i = 0;
  while (i < steps.length) {
    const step = steps[i]!;
    if (step.type === "tool_call") {
      const next = steps[i + 1];
      const result = next?.type === "tool_result" && next.name === step.name ? next : undefined;
      pairs.push({ call: step, result });
      i += result ? 2 : 1;
    } else {
      i++;
    }
  }

  if (pairs.length === 0) return null;

  return (
    <div className="space-y-1.5 my-2">
      {pairs.map((p, idx) => (
        <ToolCallPair key={idx} call={p.call} result={p.result} />
      ))}
    </div>
  );
}
