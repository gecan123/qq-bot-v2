import { Clock, MessageSquare } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { UserMemoryRow } from "@/lib/queries";
import { formatDateTime } from "@/lib/format-time";

interface UserProfileCardProps {
  user: UserMemoryRow;
}

export function UserProfileCard({ user }: UserProfileCardProps) {
  const displayName =
    user.senderGroupNickname ?? user.senderNickname ?? user.senderId;
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <Card className="bg-white border-slate-200 hover:border-slate-300 hover:shadow-sm transition-all duration-150">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600 text-sm font-semibold">
            {initial}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2">
              <p className="font-medium text-sm text-slate-800 truncate">{displayName}</p>
              {user.senderNickname && user.senderGroupNickname && (
                <span className="text-xs text-slate-400 truncate">({user.senderNickname})</span>
              )}
            </div>
            <p className="text-xs text-slate-400 font-mono">{user.senderId}</p>
            <p className="mt-2 text-sm text-slate-500 leading-relaxed line-clamp-4">
              {user.profile}
            </p>
            {user.examples.length > 0 && (
              <div className="mt-2 space-y-1">
                <p className="flex items-center gap-1 text-xs font-medium text-slate-400">
                  <MessageSquare className="h-3 w-3" />
                  典型发言
                </p>
                <ul className="space-y-0.5">
                  {user.examples.slice(0, 3).map((ex, i) => (
                    <li
                      key={i}
                      className="text-xs text-slate-400 italic pl-2 border-l-2 border-slate-100 line-clamp-1"
                    >
                      {ex}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="mt-2 flex items-center gap-1 text-xs text-slate-400">
              <Clock className="h-3 w-3" />
              {formatDateTime(user.updatedAt)}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
