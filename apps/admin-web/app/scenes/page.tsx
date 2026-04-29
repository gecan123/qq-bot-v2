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
import { getSceneStates } from "@/lib/runtime-queries";
import { compactId, previewText } from "@/lib/runtime-format";
import { formatDateTime } from "@/lib/format-time";

export default async function ScenesPage() {
  const scenes = await getSceneStates();

  return (
    <>
      <Header title="Scene States" description={`${scenes.length} runtime scenes`} />

      {scenes.length === 0 ? (
        <EmptyState>No scenes</EmptyState>
      ) : (
        <Card className="border-slate-200 bg-white">
          <CardContent className="p-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Scene</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Policy</TableHead>
                  <TableHead>Opportunities</TableHead>
                  <TableHead>Actions</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scenes.map((scene) => (
                  <TableRow key={scene.id}>
                    <TableCell>
                      <div className="font-medium text-slate-900">{scene.displayName ?? scene.externalId}</div>
                      <div className="mt-1 font-mono text-xs text-slate-400">{compactId(scene.id, 10)}</div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge value={scene.kind} />
                    </TableCell>
                    <TableCell className="max-w-sm text-xs text-slate-500">
                      {previewText(scene.policyPreview, 180)}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm text-slate-700">{scene.opportunityCount}</div>
                      <div className="mt-1 text-xs text-slate-400">{scene.pendingOpportunityCount} pending</div>
                    </TableCell>
                    <TableCell>{scene.actionCount}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-slate-500">
                      {formatDateTime(scene.lastUpdatedAt)}
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
