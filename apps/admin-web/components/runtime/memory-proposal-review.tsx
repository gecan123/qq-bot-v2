import { reviewMemoryProposalAction } from "@/lib/runtime-actions";
import { Button } from "@/components/ui/button";

export function MemoryProposalReview({
  proposalId,
  payloadText,
  disabled,
}: {
  proposalId: string;
  payloadText: string;
  disabled: boolean;
}) {
  if (disabled) {
    return <span className="text-xs text-slate-400">reviewed</span>;
  }

  return (
    <div className="grid gap-2">
      <form action={reviewMemoryProposalAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="proposalId" value={proposalId} />
        <input type="hidden" name="verdict" value="accept" />
        <input
          name="scope"
          defaultValue="global"
          className="h-8 w-28 rounded-md border border-slate-200 px-2 text-xs text-slate-700"
          aria-label="memory scope"
        />
        <Button size="sm" className="h-8 bg-emerald-600 text-white hover:bg-emerald-700">
          Accept
        </Button>
      </form>
      <form action={reviewMemoryProposalAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="proposalId" value={proposalId} />
        <input type="hidden" name="verdict" value="reject" />
        <Button size="sm" variant="outline" className="h-8 border-rose-200 text-rose-700 hover:bg-rose-50">
          Reject
        </Button>
      </form>
      <form action={reviewMemoryProposalAction} className="grid gap-2">
        <input type="hidden" name="proposalId" value={proposalId} />
        <input type="hidden" name="verdict" value="edit_accept" />
        <input
          name="scope"
          defaultValue="global"
          className="h-8 w-28 rounded-md border border-slate-200 px-2 text-xs text-slate-700"
          aria-label="edited memory scope"
        />
        <textarea
          name="payload"
          defaultValue={payloadText}
          rows={5}
          className="min-h-28 rounded-md border border-slate-200 bg-white p-2 font-mono text-xs text-slate-700"
          aria-label="edited memory payload"
        />
        <Button size="sm" variant="outline" className="h-8 justify-self-start">
          Edit and Accept
        </Button>
      </form>
    </div>
  );
}
