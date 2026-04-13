import { Header } from "@/components/layout/header";
import { TraceTable } from "@/components/llm-traces/trace-table";
import { getLlmTraceList } from "@/lib/queries";

interface PageProps {
  searchParams?: Promise<{ page?: string }>;
}

export default async function LlmTracesPage({ searchParams }: PageProps) {
  const page = Number((await searchParams)?.page ?? "1");
  const { items, total } = await getLlmTraceList(page, 30);

  return (
    <>
      <Header
        title="LLM Traces"
        description="查看每次模型调用输入，并直接进入严格回放调试"
      />

      <TraceTable
        items={items.map((item) => ({
          ...item,
          createdAt: item.createdAt.toISOString(),
        }))}
      />

      <p className="mt-3 text-xs text-slate-500">共 {total.toLocaleString("zh-CN")} 条记录</p>
    </>
  );
}
