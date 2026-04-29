import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Header } from "@/components/layout/header";
import { EmptyState } from "@/components/runtime/empty-state";
import { StatusBadge } from "@/components/runtime/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import { getReadSessions } from "@/lib/runtime-queries";
import { previewText } from "@/lib/runtime-format";
import { formatDateTime } from "@/lib/format-time";

export default async function ReadingSessionsPage() {
  const sessions = await getReadSessions();

  return (
    <>
      <Header title="Reading Sessions" description={`${sessions.length} recent sessions`} />

      {sessions.length === 0 ? (
        <EmptyState>No reading sessions</EmptyState>
      ) : (
        <div className="grid gap-3">
          {sessions.map((session) => (
            <Link key={session.id} href={`/reading-sessions/${session.id}`}>
              <Card className="border-slate-200 bg-white transition-colors hover:border-slate-300">
                <CardContent className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_180px_auto] lg:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-sm font-semibold text-slate-900">{session.title}</h2>
                      <StatusBadge value={session.status} />
                    </div>
                    <p className="mt-1 truncate text-xs text-slate-500">{session.source}</p>
                    <p className="mt-2 text-sm text-slate-600">{previewText(session.summary, 180)}</p>
                    <p className="mt-2 text-xs text-slate-400">{previewText(session.selectionReason, 140)}</p>
                  </div>
                  <div className="text-xs text-slate-500">
                    <div>{formatDateTime(session.createdAt)}</div>
                    <div className="mt-1">score {session.score ?? "—"}</div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-slate-400" />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
