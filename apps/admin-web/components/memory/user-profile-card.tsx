import { Clock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { UserMemoryRow } from "@/lib/queries";

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
            <p className="mt-2 text-sm text-slate-500 leading-relaxed line-clamp-3">
              {user.profile}
            </p>
            <p className="mt-2 flex items-center gap-1 text-xs text-slate-400">
              <Clock className="h-3 w-3" />
              {new Date(user.updatedAt).toLocaleString("zh-CN")}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
