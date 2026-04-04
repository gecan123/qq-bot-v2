import { MessageSquare, Image, Users, Activity } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Header } from "@/components/layout/header";
import { GroupCard } from "@/components/groups/group-card";
import { getGroups, getMediaCount } from "@/lib/queries";

function StatCard({
  label,
  value,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
}) {
  return (
    <Card className="bg-white border-slate-200">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-400 mb-1">{label}</p>
            <p className="text-2xl font-semibold text-slate-800">{value}</p>
          </div>
          <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${accent}`}>
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default async function HomePage() {
  const [groups, mediaCount] = await Promise.all([getGroups(), getMediaCount()]);
  const totalMessages = groups.reduce((sum, g) => sum + g.messageCount, 0);

  function formatCount(n: number) {
    if (n >= 10000) return `${(n / 10000).toFixed(1)}w`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return n.toString();
  }

  return (
    <>
      <Header title="概览" description="QQ Bot 监控数据总览" />

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 mb-8">
        <StatCard
          label="监控群组"
          value={groups.length}
          icon={Users}
          accent="bg-indigo-50 text-indigo-600"
        />
        <StatCard
          label="消息总数"
          value={formatCount(totalMessages)}
          icon={MessageSquare}
          accent="bg-blue-50 text-blue-600"
        />
        <StatCard
          label="活跃群组"
          value={groups.filter((g) => {
            const diffDays =
              (Date.now() - new Date(g.lastMessageAt).getTime()) /
              (1000 * 60 * 60 * 24);
            return diffDays <= 7;
          }).length}
          icon={Activity}
          accent="bg-emerald-50 text-emerald-600"
        />
        <StatCard
          label="媒体文件"
          value={formatCount(mediaCount)}
          icon={Image}
          accent="bg-violet-50 text-violet-600"
        />
      </div>

      {/* Groups list */}
      <div>
        <h2 className="text-xs font-medium text-slate-400 mb-3 uppercase tracking-wider">
          群组列表
        </h2>
        {groups.length === 0 ? (
          <Card className="bg-white border-slate-200">
            <CardContent className="p-8 text-center text-slate-400 text-sm">
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
      </div>
    </>
  );
}
