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
import { getOpportunities } from "@/lib/runtime-queries";
import { compactId } from "@/lib/runtime-format";
import { formatDateTime } from "@/lib/format-time";

export default async function OpportunitiesPage() {
  const opportunities = await getOpportunities();

  return (
    <>
      <Header title="Opportunities" description={`${opportunities.length} recent rows`} />

      {opportunities.length === 0 ? (
        <EmptyState>No opportunities</EmptyState>
      ) : (
        <Card className="border-slate-200 bg-white">
          <CardContent className="p-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Scene</TableHead>
                  <TableHead>Queue</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Decision</TableHead>
                  <TableHead>Actions</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {opportunities.map((opportunity) => (
                  <TableRow key={opportunity.id}>
                    <TableCell>
                      <div className="font-medium text-slate-900">{opportunity.opportunityType}</div>
                      <div className="mt-1 font-mono text-xs text-slate-400">{compactId(opportunity.id, 8)}</div>
                    </TableCell>
                    <TableCell>
                      <div className="text-slate-700">{opportunity.sceneLabel}</div>
                      <div className="mt-1 font-mono text-xs text-slate-400">{compactId(opportunity.sceneId, 8)}</div>
                    </TableCell>
                    <TableCell>
                      <div className="text-slate-700">{opportunity.queueKind}</div>
                      <div className="mt-1 text-xs text-slate-400">priority {opportunity.priority}</div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge value={opportunity.status} />
                    </TableCell>
                    <TableCell>
                      <StatusBadge value={opportunity.decisionVerdict ?? "—"} />
                    </TableCell>
                    <TableCell>{opportunity.actionIntentCount}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-slate-500">
                      {formatDateTime(opportunity.createdAt)}
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
