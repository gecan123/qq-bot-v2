import { Header } from "@/components/layout/header";
import { EmptyState } from "@/components/runtime/empty-state";
import { StatusBadge } from "@/components/runtime/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent } from "@/components/ui/card";
import { getActionRecords } from "@/lib/runtime-queries";
import { compactId, previewText } from "@/lib/runtime-format";
import { formatDateTime } from "@/lib/format-time";

export default async function ActionRecordsPage() {
  const actions = await getActionRecords();

  return (
    <>
      <Header title="Action Records" description={`${actions.length} recent rows`} />

      {actions.length === 0 ? (
        <EmptyState>No action records</EmptyState>
      ) : (
        <Card className="border-slate-200 bg-white">
          <CardContent className="p-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Action</TableHead>
                  <TableHead>Scene</TableHead>
                  <TableHead>Delivery</TableHead>
                  <TableHead>Barrier</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {actions.map((action) => (
                  <TableRow key={action.id}>
                    <TableCell>
                      <div className="font-medium text-slate-900">{action.actionType}</div>
                      <div className="mt-1 font-mono text-xs text-slate-400">{compactId(action.id, 8)}</div>
                    </TableCell>
                    <TableCell>
                      <div className="text-slate-700">{action.sceneLabel}</div>
                      <div className="mt-1 font-mono text-xs text-slate-400">{compactId(action.targetSceneId, 8)}</div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge value={action.deliveryState} />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        <StatusBadge value={action.riskBand} />
                        <StatusBadge value={action.effectMode} />
                      </div>
                      <div className="mt-1 text-xs text-slate-400">{action.reason ?? "—"}</div>
                    </TableCell>
                    <TableCell className="max-w-xs text-xs text-slate-500">
                      {previewText(action.resultPreview, 160)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-slate-500">
                      {formatDateTime(action.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  );
}
