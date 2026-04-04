import Link from "next/link";
import { MessageSquare, Clock, Brain } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { GroupSummary } from "@/lib/queries";
import { formatDate } from "@/lib/format-time";

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - new Date(date).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "刚刚";
  if (diffMins < 60) return `${diffMins} 分钟前`;
  if (diffHours < 24) return `${diffHours} 小时前`;
  if (diffDays < 30) return `${diffDays} 天前`;
  return formatDate(date);
}

function formatCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

interface GroupCardProps {
  group: GroupSummary;
}

export function GroupCard({ group }: GroupCardProps) {
  const displayName = group.groupName ?? `群 ${group.groupId}`;
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <Card className="bg-white border-slate-200 hover:border-slate-300 hover:shadow-sm transition-all duration-150">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          {/* Avatar */}
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600 font-semibold text-sm">
            {initial}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <Link
                href={`/groups/${group.groupId}`}
                className="font-medium text-sm text-slate-800 truncate hover:text-indigo-600 transition-colors cursor-pointer"
              >
                {displayName}
              </Link>
              <Badge
                variant="secondary"
                className="bg-slate-100 text-slate-500 border-slate-200 text-xs shrink-0"
              >
                {formatCount(group.messageCount)} 条
              </Badge>
            </div>

            <p className="text-xs text-slate-400 font-mono mt-0.5">{group.groupId}</p>

            <div className="flex items-center gap-3 mt-2.5 text-xs text-slate-400">
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {formatRelativeTime(group.lastMessageAt)}
              </span>
              <Link
                href={`/groups/${group.groupId}`}
                className="flex items-center gap-1 text-indigo-500 hover:text-indigo-600 transition-colors cursor-pointer"
              >
                <MessageSquare className="h-3 w-3" />
                消息
              </Link>
              <Link
                href={`/groups/${group.groupId}/memory`}
                className="flex items-center gap-1 text-slate-400 hover:text-violet-600 transition-colors cursor-pointer"
              >
                <Brain className="h-3 w-3" />
                记忆
              </Link>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
