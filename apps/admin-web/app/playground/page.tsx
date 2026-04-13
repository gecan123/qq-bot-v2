import { Header } from "@/components/layout/header";
import { AgentSandbox } from "@/components/playground/agent-sandbox";
import { getGroups } from "@/lib/queries";

interface PlaygroundPageProps {
  searchParams?: Promise<{ replayTraceId?: string }>;
}

export default async function PlaygroundPage({ searchParams }: PlaygroundPageProps) {
  const replayTraceId = Number((await searchParams)?.replayTraceId ?? "");
  const groups = await getGroups();

  return (
    <>
      <Header
        title="Playground"
        description="测试 Agent 回复流程，不发送到 QQ"
      />
      {groups.length === 0 ? (
        <div className="text-center text-slate-400 text-sm py-16">
          暂无群组数据，请先确保 bot 已接收过群消息
        </div>
      ) : (
        <AgentSandbox groups={groups} replayTraceId={Number.isFinite(replayTraceId) ? replayTraceId : null} />
      )}
    </>
  );
}
