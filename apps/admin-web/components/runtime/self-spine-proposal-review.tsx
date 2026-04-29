import { reviewSelfSpineProposalAction } from "@/lib/runtime-actions";
import { Button } from "@/components/ui/button";

export function SelfSpineProposalReview({
  proposalId,
  disabled,
}: {
  proposalId: string;
  disabled: boolean;
}) {
  if (disabled) {
    return <span className="text-xs text-slate-400">reviewed</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <form action={reviewSelfSpineProposalAction}>
        <input type="hidden" name="proposalId" value={proposalId} />
        <input type="hidden" name="verdict" value="accept" />
        <input type="hidden" name="reviewedBy" value="admin" />
        <Button size="sm" className="h-8 bg-emerald-600 text-white hover:bg-emerald-700">
          Accept
        </Button>
      </form>
      <form action={reviewSelfSpineProposalAction}>
        <input type="hidden" name="proposalId" value={proposalId} />
        <input type="hidden" name="verdict" value="reject" />
        <input type="hidden" name="reviewedBy" value="admin" />
        <Button size="sm" variant="outline" className="h-8 border-rose-200 text-rose-700 hover:bg-rose-50">
          Reject
        </Button>
      </form>
    </div>
  );
}
