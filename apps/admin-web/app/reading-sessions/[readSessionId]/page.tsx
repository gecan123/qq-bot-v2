import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight, ExternalLink } from "lucide-react";
import { Header } from "@/components/layout/header";
import { JsonBlock } from "@/components/runtime/json-block";
import { ReadSessionReviewForm } from "@/components/runtime/read-session-review-form";
import { StatusBadge } from "@/components/runtime/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import { getReadSessionDetail } from "@/lib/runtime-queries";
import { compactId, previewText } from "@/lib/runtime-format";
import { formatDateTime } from "@/lib/format-time";

interface Props {
  params: Promise<{ readSessionId: string }>;
}

export default async function ReadingSessionDetailPage({ params }: Props) {
  const { readSessionId } = await params;
  const session = await getReadSessionDetail(readSessionId);
  if (!session) notFound();

  return (
    <>
      <nav className="mb-5 flex items-center gap-1.5 text-xs text-slate-400">
        <Link href="/reading-sessions" className="hover:text-slate-600">
          Reading Sessions
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-slate-600">{compactId(session.id, 10)}</span>
      </nav>

      <Header
        title={session.feedItem?.title ?? session.title}
        description={session.feedItem?.url ?? session.source}
        actions={<StatusBadge value={session.status} />}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid gap-4">
          <Card className="border-slate-200 bg-white">
            <CardContent className="grid gap-4 p-5">
              <div>
                <h2 className="mb-2 text-sm font-semibold text-slate-900">Source</h2>
                <div className="grid gap-2 text-sm text-slate-600">
                  <div>author: {session.feedItem?.author ?? "—"}</div>
                  <div>published: {session.feedItem?.publishedAt ? formatDateTime(session.feedItem.publishedAt) : "—"}</div>
                  <div>seen: {session.feedItem ? formatDateTime(session.feedItem.seenAt) : "—"}</div>
                  {session.feedItem?.url && (
                    <a
                      href={session.feedItem.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-sky-700 hover:text-sky-900"
                    >
                      open source <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </div>
              <div>
                <h2 className="mb-2 text-sm font-semibold text-slate-900">Selection Reason</h2>
                <p className="text-sm leading-6 text-slate-700">{session.selectionReason}</p>
              </div>
              <div>
                <h2 className="mb-2 text-sm font-semibold text-slate-900">Summary</h2>
                <p className="text-sm leading-6 text-slate-700">{session.summary}</p>
              </div>
              <div>
                <h2 className="mb-2 text-sm font-semibold text-slate-900">Thoughts</h2>
                <p className="text-sm leading-6 text-slate-700">{session.thought ?? "—"}</p>
              </div>
              <div>
                <h2 className="mb-2 text-sm font-semibold text-slate-900">Rationale</h2>
                <p className="text-sm leading-6 text-slate-700">{session.rationale ?? "—"}</p>
              </div>
              <div>
                <h2 className="mb-2 text-sm font-semibold text-slate-900">Raw Content</h2>
                <p className="whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-3 text-sm leading-6 text-slate-700">
                  {previewText(session.feedItem?.rawContent, 2000)}
                </p>
              </div>
            </CardContent>
          </Card>

        </div>

        <div className="grid content-start gap-4">
          <Card className="border-slate-200 bg-white">
            <CardContent className="p-5">
              <h2 className="mb-4 text-sm font-semibold text-slate-900">Review</h2>
              <ReadSessionReviewForm readSessionId={session.id} score={session.score} notes={session.notes} />
            </CardContent>
          </Card>

          <Card className="border-slate-200 bg-white">
            <CardContent className="p-5">
              <h2 className="mb-3 text-sm font-semibold text-slate-900">Action Record</h2>
              {session.actionRecord ? (
                <div className="grid gap-3 text-sm text-slate-600">
                  <div className="flex items-center justify-between gap-2">
                    <span>{session.actionRecord.actionType}</span>
                    <StatusBadge value={session.actionRecord.deliveryState} />
                  </div>
                  <div>effect: {session.actionRecord.effectMode ?? "—"}</div>
                  <div>risk: {session.actionRecord.riskBand ?? "—"}</div>
                  <JsonBlock value={session.actionRecord.resultPayload} />
                </div>
              ) : (
                <p className="text-sm text-slate-400">No action record</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
