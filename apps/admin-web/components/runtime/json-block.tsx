import { jsonText } from "@/lib/runtime-format";
import { cn } from "@/lib/utils";

export function JsonBlock({
  value,
  className,
}: {
  value: unknown;
  className?: string;
}) {
  const text = jsonText(value);
  return (
    <pre
      className={cn(
        "max-h-72 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed text-slate-700",
        className
      )}
    >
      {text || "—"}
    </pre>
  );
}
