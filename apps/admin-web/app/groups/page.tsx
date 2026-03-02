import { Header } from "@/components/layout/header";
import { GroupCard } from "@/components/groups/group-card";
import { getGroups } from "@/lib/queries";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default async function GroupsPage() {
  const groups = await getGroups();
  const totalMessages = groups.reduce((sum, g) => sum + g.messageCount, 0);

  return (
    <>
      <Header
        title="群组"
        description="所有监控中的 QQ 群组"
        actions={
          <Badge variant="secondary" className="bg-slate-100 text-slate-500 border-slate-200">
            {groups.length} 个群组 · {totalMessages.toLocaleString("zh-CN")} 条消息
          </Badge>
        }
      />

      {groups.length === 0 ? (
        <Card className="bg-white border-slate-200">
          <CardContent className="p-12 text-center text-slate-400 text-sm">
            暂无群组数据
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((group) => (
            <GroupCard key={group.groupId} group={group} />
          ))}
        </div>
      )}
    </>
  );
}
