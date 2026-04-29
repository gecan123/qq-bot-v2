import { Card, CardContent } from "@/components/ui/card";

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <Card className="border-slate-200 bg-white">
      <CardContent className="p-8 text-center text-sm text-slate-400">{children}</CardContent>
    </Card>
  );
}
