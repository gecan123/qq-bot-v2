import { Header } from "@/components/layout/header";
import { JsonBlock } from "@/components/runtime/json-block";
import { MemoryProposalReview } from "@/components/runtime/memory-proposal-review";
import { StatusBadge } from "@/components/runtime/status-badge";
import { EmptyState } from "@/components/runtime/empty-state";
import { Card, CardContent } from "@/components/ui/card";
import { getMemoryProposals } from "@/lib/runtime-queries";
import { compactId, percentLabel } from "@/lib/runtime-format";
import { formatDateTime } from "@/lib/format-time";

export default async function MemoryProposalsPage() {
  const proposals = await getMemoryProposals();
  const pending = proposals.filter((proposal) => proposal.status === "proposed").length;

  return (
    <>
      <Header title="Memory Proposals" description={`${pending} pending · ${proposals.length} recent rows`} />

      {proposals.length === 0 ? (
        <EmptyState>No memory proposals</EmptyState>
      ) : (
        <div className="grid gap-4">
          {proposals.map((proposal) => (
            <Card key={proposal.id} className="border-slate-200 bg-white">
              <CardContent className="grid gap-4 p-5 xl:grid-cols-[minmax(0,1fr)_340px]">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold text-slate-900">{proposal.proposalType}</h2>
                    <StatusBadge value={proposal.status} />
                    {proposal.memoryItemId && <StatusBadge value="active" />}
                  </div>
                  <div className="mt-2 grid gap-1 text-xs text-slate-500 sm:grid-cols-2">
                    <div>id {compactId(proposal.id, 10)}</div>
                    <div>agent {proposal.agentId}</div>
                    <div>confidence {percentLabel(proposal.confidence)}</div>
                    <div>salience {percentLabel(proposal.salience)}</div>
                    <div>created {formatDateTime(proposal.createdAt)}</div>
                    <div>updated {formatDateTime(proposal.updatedAt)}</div>
                  </div>
                  <div className="mt-4 grid gap-3 lg:grid-cols-2">
                    <div>
                      <h3 className="mb-2 text-xs font-medium uppercase text-slate-400">Payload</h3>
                      <JsonBlock value={JSON.parse(proposal.payloadText)} />
                    </div>
                    <div>
                      <h3 className="mb-2 text-xs font-medium uppercase text-slate-400">Source</h3>
                      <pre className="max-h-72 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed text-slate-700">
                        {proposal.sourcePreview}
                      </pre>
                    </div>
                  </div>
                </div>
                <MemoryProposalReview
                  proposalId={proposal.id}
                  payloadText={proposal.payloadText}
                  disabled={proposal.status !== "proposed"}
                />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
