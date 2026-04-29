import { upsertReadSessionReviewAction } from "@/lib/runtime-actions";
import { Button } from "@/components/ui/button";

export function ReadSessionReviewForm({
  readSessionId,
  score,
  notes,
}: {
  readSessionId: string;
  score: number | null;
  notes: string | null;
}) {
  return (
    <form action={upsertReadSessionReviewAction} className="grid gap-3">
      <input type="hidden" name="readSessionId" value={readSessionId} />
      <div className="grid gap-2 sm:grid-cols-[120px_1fr]">
        <label className="text-xs font-medium uppercase text-slate-500" htmlFor="score">
          Score
        </label>
        <input
          id="score"
          name="score"
          type="number"
          min={1}
          max={5}
          defaultValue={score ?? ""}
          className="h-9 w-24 rounded-md border border-slate-200 px-2 text-sm text-slate-700"
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-[120px_1fr]">
        <label className="text-xs font-medium uppercase text-slate-500" htmlFor="notes">
          Notes
        </label>
        <textarea
          id="notes"
          name="notes"
          defaultValue={notes ?? ""}
          rows={4}
          className="rounded-md border border-slate-200 bg-white p-2 text-sm text-slate-700"
        />
      </div>
      <Button className="justify-self-start">Save Review</Button>
    </form>
  );
}
