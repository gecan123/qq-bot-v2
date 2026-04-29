import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function MetricCard({
  label,
  value,
  icon: Icon,
  className,
}: {
  label: string;
  value: string | number;
  icon: LucideIcon;
  className?: string;
}) {
  return (
    <Card className="border-slate-200 bg-white">
      <CardContent className="flex h-full items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-slate-500">{label}</p>
          <p className="mt-1 text-2xl font-semibold tracking-normal text-slate-900">{value}</p>
        </div>
        <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-md", className)}>
          <Icon className="h-4 w-4" />
        </div>
      </CardContent>
    </Card>
  );
}
