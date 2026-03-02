import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { Header } from "@/components/layout/header";
import { MemoryCard } from "@/components/memory/memory-card";
import { UserProfileCard } from "@/components/memory/user-profile-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { getGroupMemory, getUserMemories, getGroups } from "@/lib/queries";

interface Props {
  params: Promise<{ groupId: string }>;
}

export default async function GroupMemoryPage({ params }: Props) {
  const { groupId } = await params;

  const [memory, userMemories, groups] = await Promise.all([
    getGroupMemory(groupId),
    getUserMemories(groupId),
    getGroups(),
  ]);

  const group = groups.find((g) => g.groupId === groupId);
  if (!group && !memory && userMemories.length === 0) {
    notFound();
  }

  const displayName = group?.groupName ?? memory?.groupName ?? `群 ${groupId}`;

  return (
    <>
      <nav className="flex items-center gap-1.5 text-xs text-slate-400 mb-5">
        <Link href="/groups" className="hover:text-slate-600 transition-colors cursor-pointer">
          群组
        </Link>
        <ChevronRight className="h-3 w-3" />
        <Link
          href={`/groups/${groupId}`}
          className="hover:text-slate-600 transition-colors cursor-pointer"
        >
          {displayName}
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-slate-600">记忆</span>
      </nav>

      <Header
        title="群组记忆"
        description={displayName}
        actions={
          <Badge variant="secondary" className="bg-slate-100 text-slate-500 border-slate-200">
            {userMemories.length} 个用户画像
          </Badge>
        }
      />

      {memory ? (
        <div className="mb-6">
          <MemoryCard memory={memory} />
        </div>
      ) : (
        <Card className="bg-white border-slate-200 mb-6">
          <CardContent className="p-6 text-center text-slate-400 text-sm">
            暂无群组记忆
          </CardContent>
        </Card>
      )}

      <h2 className="text-xs font-medium text-slate-400 mb-3 uppercase tracking-wider">
        用户画像
      </h2>
      {userMemories.length === 0 ? (
        <Card className="bg-white border-slate-200">
          <CardContent className="p-8 text-center text-slate-400 text-sm">
            暂无用户画像数据
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {userMemories.map((user) => (
            <UserProfileCard key={user.id} user={user} />
          ))}
        </div>
      )}
    </>
  );
}
