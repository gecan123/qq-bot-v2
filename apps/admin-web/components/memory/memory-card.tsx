import { Brain, Clock } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { GroupMemoryRow } from "@/lib/queries";
import { formatDateTime } from "@/lib/format-time";

interface MemoryCardProps {
  memory: GroupMemoryRow;
}

export function MemoryCard({ memory }: MemoryCardProps) {
  return (
    <Card className="bg-white border-slate-200">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-100 text-violet-600">
            <Brain className="h-4 w-4" />
          </div>
          <div>
            <p className="font-semibold text-sm text-slate-800">群组记忆</p>
            <p className="text-xs text-slate-400">AI 生成的群组摘要</p>
          </div>
        </div>
      </CardHeader>
      <Separator className="bg-slate-100 mb-4" />
      <CardContent>
        <p className="text-sm text-slate-600 leading-relaxed whitespace-pre-wrap">
          {memory.summary}
        </p>
        <div className="mt-4 flex items-center gap-4 text-xs text-slate-400">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatDateTime(memory.updatedAt)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
