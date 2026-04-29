import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STATUS_CLASS: Record<string, string> = {
  accepted: "border-emerald-200 bg-emerald-50 text-emerald-700",
  active: "border-emerald-200 bg-emerald-50 text-emerald-700",
  acked: "border-emerald-200 bg-emerald-50 text-emerald-700",
  approved: "border-emerald-200 bg-emerald-50 text-emerald-700",
  completed: "border-emerald-200 bg-emerald-50 text-emerald-700",
  consumed: "border-emerald-200 bg-emerald-50 text-emerald-700",
  live: "border-emerald-200 bg-emerald-50 text-emerald-700",
  sent: "border-emerald-200 bg-emerald-50 text-emerald-700",
  dry_run: "border-sky-200 bg-sky-50 text-sky-700",
  edited: "border-sky-200 bg-sky-50 text-sky-700",
  pending: "border-amber-200 bg-amber-50 text-amber-700",
  proposed: "border-amber-200 bg-amber-50 text-amber-700",
  requires_review: "border-amber-200 bg-amber-50 text-amber-700",
  blocked: "border-rose-200 bg-rose-50 text-rose-700",
  failed: "border-rose-200 bg-rose-50 text-rose-700",
  rejected: "border-rose-200 bg-rose-50 text-rose-700",
  suppressed: "border-slate-200 bg-slate-50 text-slate-600",
  skipped: "border-slate-200 bg-slate-50 text-slate-600",
  superseded: "border-slate-200 bg-slate-50 text-slate-600",
};

export function StatusBadge({
  value,
  className,
}: {
  value: string | null | undefined;
  className?: string;
}) {
  const normalized = value ?? "unknown";
  return (
    <Badge
      variant="outline"
      className={cn(
        "whitespace-nowrap font-medium",
        STATUS_CLASS[normalized] ?? "border-slate-200 bg-white text-slate-600",
        className
      )}
    >
      {normalized}
    </Badge>
  );
}
