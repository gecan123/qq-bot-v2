import { Header } from "@/components/layout/header";
import { EmptyState } from "@/components/runtime/empty-state";
import { SelfSpineProposalReview } from "@/components/runtime/self-spine-proposal-review";
import { StatusBadge } from "@/components/runtime/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import { getSelfSpineOverview } from "@/lib/runtime-queries";
import { compactId, previewText } from "@/lib/runtime-format";
import { formatDateTime } from "@/lib/format-time";

export default async function SelfSpinePage() {
  const overview = await getSelfSpineOverview();

  return (
    <>
      <Header
        title="Self Spine"
        description={`${overview.versions.length} versions · ${overview.proposals.length} proposals`}
      />

      <div className="grid gap-6">
        <section>
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Versions</h2>
          {overview.versions.length === 0 ? (
            <EmptyState>No Self Spine versions</EmptyState>
          ) : (
            <div className="grid gap-3">
              {overview.versions.map((version) => (
                <Card key={version.id} className="border-slate-200 bg-white">
                  <CardContent className="grid gap-3 p-4 lg:grid-cols-[160px_minmax(0,1fr)_auto] lg:items-start">
                    <div>
                      <div className="text-sm font-semibold text-slate-900">v{version.version}</div>
                      <div className="mt-1 font-mono text-xs text-slate-400">{compactId(version.id, 8)}</div>
                      <div className="mt-2">
                        <StatusBadge value={version.status} />
                      </div>
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap gap-1.5">
                        {version.changedSections.map((section) => (
                          <StatusBadge key={section} value={section} />
                        ))}
                      </div>
                      <p className="mt-3 text-xs text-slate-500">{previewText(version.diffPreview, 220)}</p>
                    </div>
                    <div className="whitespace-nowrap text-xs text-slate-500">{formatDateTime(version.createdAt)}</div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Update Proposals</h2>
          {overview.proposals.length === 0 ? (
            <EmptyState>No Self Spine update proposals</EmptyState>
          ) : (
            <div className="grid gap-3">
              {overview.proposals.map((proposal) => (
                <Card key={proposal.id} className="border-slate-200 bg-white">
                  <CardContent className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_220px]">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-slate-400">{compactId(proposal.id, 10)}</span>
                        <StatusBadge value={proposal.status} />
                      </div>
                      <p className="mt-3 text-sm leading-6 text-slate-700">{proposal.rationale}</p>
                      <p className="mt-2 text-xs text-slate-500">{previewText(proposal.patchPreview, 220)}</p>
                    </div>
                    <div className="text-xs text-slate-500">
                      <div>{formatDateTime(proposal.createdAt)}</div>
                      <div className="mt-1">reviewed by {proposal.reviewedBy ?? "—"}</div>
                      <div className="mt-3">
                        <SelfSpineProposalReview proposalId={proposal.id} disabled={proposal.status !== "proposed"} />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
