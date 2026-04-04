import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight, Brain } from "lucide-react";
import { Header } from "@/components/layout/header";
import { MessageFeed } from "@/components/messages/message-feed";
import { MessageSearch } from "@/components/messages/message-search";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getGroupMessages, getGroups } from "@/lib/queries";

interface Props {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<{ page?: string; search?: string }>;
}

const PAGE_SIZE = 50;

export default async function GroupDetailPage({ params, searchParams }: Props) {
  const { groupId } = await params;
  const { page: pageParam, search } = await searchParams;
  const page = Math.max(1, parseInt(pageParam ?? "1", 10));

  const [{ messages, total }, groups] = await Promise.all([
    getGroupMessages(groupId, page, PAGE_SIZE, search),
    getGroups(),
  ]);

  const group = groups.find((g) => g.groupId === groupId);
  if (!group && messages.length === 0 && total === 0) {
    notFound();
  }

  const displayName = group?.groupName ?? `群 ${groupId}`;

  return (
    <>
      <nav className="flex items-center gap-1.5 text-xs text-slate-400 mb-5">
        <Link href="/groups" className="hover:text-slate-600 transition-colors cursor-pointer">
          群组
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-slate-600">{displayName}</span>
      </nav>

      <Header
        title={displayName}
        description={`群号：${groupId}`}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="bg-slate-100 text-slate-500 border-slate-200">
              {total.toLocaleString("zh-CN")} 条消息
            </Badge>
            <MessageSearch defaultValue={search} />
            <Button
              variant="outline"
              size="sm"
              className="h-8 border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900 cursor-pointer"
              asChild
            >
              <Link href={`/groups/${groupId}/memory`}>
                <Brain className="h-4 w-4 mr-1.5" />
                群组记忆
              </Link>
            </Button>
          </div>
        }
      />

      <Card className="bg-white border-slate-200">
        <CardContent className="p-4 sm:p-6">
          <MessageFeed
            messages={messages}
            total={total}
            page={page}
            pageSize={PAGE_SIZE}
            baseUrl={`/groups/${groupId}`}
            search={search}
          />
        </CardContent>
      </Card>
    </>
  );
}
