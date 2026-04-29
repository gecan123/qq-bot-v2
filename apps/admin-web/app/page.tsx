import Link from "next/link";
import {
  Activity,
  BookOpen,
  ClipboardList,
  DatabaseZap,
  GitBranch,
  Inbox,
  Route,
} from "lucide-react";
import { Header } from "@/components/layout/header";
import { MetricCard } from "@/components/runtime/metric-card";
import { StatusBadge } from "@/components/runtime/status-badge";
import { EmptyState } from "@/components/runtime/empty-state";
import { Card, CardContent } from "@/components/ui/card";
import { getRuntimeDashboard } from "@/lib/runtime-queries";
import { compactId } from "@/lib/runtime-format";
import { formatDateTime } from "@/lib/format-time";

const ICONS = [Activity, Route, ClipboardList, BookOpen, DatabaseZap, GitBranch];

export default async function HomePage() {
  const dashboard = await getRuntimeDashboard();

  return (
    <>
      <Header
        title="Today"
        description={`since ${formatDateTime(dashboard.todayStart)}`}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {dashboard.stats.map((stat, index) => (
          <MetricCard
            key={stat.label}
            label={stat.label}
            value={stat.value}
            icon={ICONS[index] ?? Activity}
            className="bg-slate-100 text-slate-700"
          />
        ))}
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Activity</h2>
            <span className="text-xs text-slate-400">{dashboard.activity.length} rows</span>
          </div>
          {dashboard.activity.length === 0 ? (
            <EmptyState>No runtime activity today</EmptyState>
          ) : (
            <div className="grid gap-2">
              {dashboard.activity.map((item) => (
                <Link key={`${item.type}:${item.id}`} href={item.href}>
                  <Card className="border-slate-200 bg-white transition-colors hover:border-slate-300">
                    <CardContent className="grid gap-3 p-4 sm:grid-cols-[120px_minmax(0,1fr)_auto] sm:items-center">
                      <div className="text-xs font-medium uppercase text-slate-400">{item.type}</div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-slate-900">{item.title}</div>
                        <div className="mt-1 truncate text-xs text-slate-500">
                          {item.subtitle} · {compactId(item.id, 8)}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 sm:justify-end">
                        <span className="text-xs text-slate-400">{formatDateTime(item.createdAt)}</span>
                        <StatusBadge value={item.status} />
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div>
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Review Queue</h2>
          <div className="grid gap-3">
            <Link href="/memory-proposals">
              <MetricCard
                label="Pending Memory"
                value={dashboard.reviewQueues.pendingMemoryProposals}
                icon={DatabaseZap}
                className="bg-amber-50 text-amber-700"
              />
            </Link>
            <Link href="/self-spine">
              <MetricCard
                label="Pending Spine"
                value={dashboard.reviewQueues.pendingSelfSpineProposals}
                icon={GitBranch}
                className="bg-sky-50 text-sky-700"
              />
            </Link>
            <Link href="/reading-sessions">
              <MetricCard
                label="Unreviewed Reads"
                value={dashboard.reviewQueues.unreviewedReadSessions}
                icon={Inbox}
                className="bg-rose-50 text-rose-700"
              />
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
