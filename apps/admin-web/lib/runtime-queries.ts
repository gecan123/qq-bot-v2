import { getPrisma } from "./prisma";
import {
  jsonPreview,
  previewText,
  startOfShanghaiDay,
} from "./runtime-format";

export interface DashboardStat {
  label: string;
  value: number;
}

export interface ActivityItem {
  id: string;
  type: "event" | "opportunity" | "action" | "read";
  title: string;
  subtitle: string;
  status: string;
  href: string;
  createdAt: Date;
}

export interface CacheHealth24h {
  totalCalls: number;
  capturedCalls: number;
  cacheHitCalls: number;
  capturedRatio: number;
  cacheHitRatio: number;
  totalInputTokens: number;
  totalCachedTokens: number;
}

export interface RuntimeDashboard {
  todayStart: Date;
  stats: DashboardStat[];
  activity: ActivityItem[];
  reviewQueues: {
    unreviewedReadSessions: number;
  };
  cacheHealth: CacheHealth24h;
}

export interface ReadSessionListItem {
  id: string;
  status: string;
  selectionReason: string;
  title: string;
  source: string;
  summary: string;
  score: number | null;
  notes: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface ReadSessionDetail extends ReadSessionListItem {
  feedItem: {
    id: string;
    url: string | null;
    title: string;
    author: string | null;
    rawContent: string | null;
    publishedAt: Date | null;
    seenAt: Date;
    contentHash: string | null;
  } | null;
  thought: string | null;
  rationale: string | null;
  opportunityId: string;
  actionRecordId: string | null;
  actionRecord: RuntimeActionRecordRow | null;
}

export interface RuntimeOpportunityRow {
  id: string;
  sceneId: string;
  sceneLabel: string;
  queueKind: string;
  opportunityType: string;
  status: string;
  priority: number;
  payloadPreview: string;
  decisionVerdict: string | null;
  actionIntentCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RuntimeActionRecordRow {
  id: string;
  actionIntentId: string;
  actionType: string;
  targetSceneId: string;
  sceneLabel: string;
  deliveryState: string;
  riskBand: string | null;
  effectMode: string | null;
  reason: string | null;
  resultPreview: string;
  resultPayload: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface SceneStateRow {
  id: string;
  kind: string;
  externalId: string;
  displayName: string | null;
  policyPreview: string;
  opportunityCount: number;
  pendingOpportunityCount: number;
  actionCount: number;
  lastUpdatedAt: Date;
}

/**
 * Phase 1.5 观测页面用的聚合结构。
 * 一个 sceneId 一行, 显示这个 scene 在最近窗口里 LLM 调用的 cache 健康度。
 */
export interface LlmTraceSceneSummary {
  sceneId: string;
  callCount: number;
  capturedCount: number;
  cacheHitCount: number;
  totalInputTokens: number;
  totalCachedTokens: number;
  avgCacheHitRatio: number;
  uniquePrefixHashes: number;
  lastCallAt: Date;
}

export interface LlmTraceCallRow {
  id: number;
  loopIndex: number | null;
  prefixHash: string | null;
  inputHash: string | null;
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  tokenUsageState: string | null;
  model: string | null;
  durationMs: number;
  error: string | null;
  createdAt: Date;
}

export interface LlmTraceSceneDetail {
  sceneId: string;
  summary: LlmTraceSceneSummary;
  /** 时间倒序 */
  recentCalls: LlmTraceCallRow[];
  /** P0 验证三件套 */
  verdict: {
    prefixStable: boolean;
    cacheHit: boolean;
    captured: boolean;
  };
}

function sceneLabel(scene: { displayName: string | null; kind: string; externalId: string } | undefined): string {
  if (!scene) return "unknown scene";
  return scene.displayName ?? `${scene.kind}:${scene.externalId}`;
}

function barrierField(payload: unknown, key: "riskBand" | "effectMode" | "reason"): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const obj = payload as Record<string, unknown>;
  const verdict = obj.barrierVerdict;
  if (verdict && typeof verdict === "object" && !Array.isArray(verdict)) {
    const v = (verdict as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  const direct = obj[key];
  return typeof direct === "string" ? direct : null;
}

function activityStatus(status: string | null | undefined): string {
  return status ?? "recorded";
}

export async function getRuntimeDashboard(): Promise<RuntimeDashboard> {
  const prisma = getPrisma();
  const todayStart = startOfShanghaiDay();
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    eventCount,
    opportunityCount,
    actionCount,
    readCount,
    totalReadSessions,
    reviewedReadSessions,
    events,
    opportunities,
    actions,
    reads,
    cacheStats,
  ] = await Promise.all([
    prisma.runtimeEvent.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.opportunity.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.actionRecord.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.readSession.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.readSession.count(),
    prisma.readSessionReview.groupBy({ by: ["readSessionId"] }),
    prisma.runtimeEvent.findMany({ where: { createdAt: { gte: todayStart } }, orderBy: { createdAt: "desc" }, take: 8 }),
    prisma.opportunity.findMany({ where: { createdAt: { gte: todayStart } }, orderBy: { createdAt: "desc" }, take: 8 }),
    prisma.actionRecord.findMany({ where: { createdAt: { gte: todayStart } }, orderBy: { createdAt: "desc" }, take: 8 }),
    prisma.readSession.findMany({ where: { createdAt: { gte: todayStart } }, orderBy: { createdAt: "desc" }, take: 8 }),
    prisma.llmTrace.findMany({
      where: { createdAt: { gte: last24h } },
      select: { tokenUsageState: true, inputTokens: true, cachedTokens: true },
    }),
  ]);

  const cacheHealth = computeCacheHealth(cacheStats);

  const activity: ActivityItem[] = [
    ...events.map((event) => ({
      id: event.id,
      type: "event" as const,
      title: event.eventType,
      subtitle: event.sceneId,
      status: event.consumedAt ? "consumed" : "pending",
      href: "/opportunities",
      createdAt: event.createdAt,
    })),
    ...opportunities.map((opportunity) => ({
      id: opportunity.id,
      type: "opportunity" as const,
      title: opportunity.opportunityType,
      subtitle: `${opportunity.queueKind} · ${opportunity.sceneId}`,
      status: activityStatus(opportunity.status),
      href: "/opportunities",
      createdAt: opportunity.createdAt,
    })),
    ...actions.map((action) => ({
      id: action.id,
      type: "action" as const,
      title: action.actionType,
      subtitle: action.targetSceneId,
      status: activityStatus(action.deliveryState),
      href: "/action-records",
      createdAt: action.createdAt,
    })),
    ...reads.map((read) => ({
      id: read.id,
      type: "read" as const,
      title: "read session",
      subtitle: previewText(read.selectionReason, 80),
      status: activityStatus(read.status),
      href: `/reading-sessions/${read.id}`,
      createdAt: read.createdAt,
    })),
  ]
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .slice(0, 18);

  return {
    todayStart,
    stats: [
      { label: "Runtime Events", value: eventCount },
      { label: "Opportunities", value: opportunityCount },
      { label: "Action Records", value: actionCount },
      { label: "Reading Sessions", value: readCount },
      { label: "LLM Calls (24h)", value: cacheHealth.totalCalls },
      {
        label: "Cache Hit %",
        value: Math.round(cacheHealth.cacheHitRatio * 100),
      },
    ],
    activity,
    reviewQueues: {
      unreviewedReadSessions: Math.max(0, totalReadSessions - reviewedReadSessions.length),
    },
    cacheHealth,
  };
}

function computeCacheHealth(
  rows: Array<{
    tokenUsageState: string | null;
    inputTokens: number | null;
    cachedTokens: number | null;
  }>,
): CacheHealth24h {
  let capturedCalls = 0;
  let cacheHitCalls = 0;
  let totalInputTokens = 0;
  let totalCachedTokens = 0;
  for (const row of rows) {
    if (row.tokenUsageState === "captured") capturedCalls++;
    if ((row.cachedTokens ?? 0) > 0) cacheHitCalls++;
    totalInputTokens += row.inputTokens ?? 0;
    totalCachedTokens += row.cachedTokens ?? 0;
  }
  const totalCalls = rows.length;
  return {
    totalCalls,
    capturedCalls,
    cacheHitCalls,
    capturedRatio: totalCalls === 0 ? 0 : capturedCalls / totalCalls,
    cacheHitRatio: totalCalls === 0 ? 0 : cacheHitCalls / totalCalls,
    totalInputTokens,
    totalCachedTokens,
  };
}

async function hydrateReadSessions(ids?: string[]): Promise<ReadSessionListItem[]> {
  const prisma = getPrisma();
  const sessions = await prisma.readSession.findMany({
    where: ids ? { id: { in: ids } } : undefined,
    orderBy: { createdAt: "desc" },
    take: ids ? undefined : 50,
  });
  const readIds = sessions.map((session) => session.id);
  const feedItemIds = sessions.map((session) => session.feedItemId);

  const [feedItems, summaries, reviews] = await Promise.all([
    prisma.feedItem.findMany({ where: { id: { in: feedItemIds } } }),
    prisma.sourceSummary.findMany({ where: { readSessionId: { in: readIds } } }),
    prisma.readSessionReview.findMany({ where: { readSessionId: { in: readIds } }, orderBy: { updatedAt: "desc" } }),
  ]);

  const feedSourceIds = feedItems.map((item) => item.feedSourceId);
  const feedSources = await prisma.feedSource.findMany({ where: { id: { in: feedSourceIds } } });

  const itemById = new Map(feedItems.map((item) => [item.id, item]));
  const sourceById = new Map(feedSources.map((source) => [source.id, source]));
  const summaryByReadId = new Map(summaries.map((summary) => [summary.readSessionId, summary.summary]));
  const reviewByReadId = new Map(reviews.map((review) => [review.readSessionId, review]));

  return sessions.map((session) => {
    const item = itemById.get(session.feedItemId);
    const source = item ? sourceById.get(item.feedSourceId) : undefined;
    const review = reviewByReadId.get(session.id);
    return {
      id: session.id,
      status: session.status,
      selectionReason: session.selectionReason,
      title: item?.title ?? session.feedItemId,
      source: source?.displayName ?? source?.externalId ?? "unknown source",
      summary: summaryByReadId.get(session.id) ?? "—",
      score: review?.score ?? null,
      notes: review?.notes ?? null,
      createdAt: session.createdAt,
      completedAt: session.completedAt,
    };
  });
}

export async function getReadSessions(): Promise<ReadSessionListItem[]> {
  return hydrateReadSessions();
}

export async function getReadSessionDetail(id: string): Promise<ReadSessionDetail | null> {
  const prisma = getPrisma();
  const session = await prisma.readSession.findUnique({ where: { id } });
  if (!session) return null;

  const [base] = await hydrateReadSessions([id]);
  if (!base) return null;

  const [feedItem, thought, rationale, review, actionRecord] = await Promise.all([
    prisma.feedItem.findUnique({ where: { id: session.feedItemId } }),
    prisma.thoughtArtifact.findFirst({ where: { readSessionId: id }, orderBy: { createdAt: "desc" } }),
    prisma.rationaleArtifact.findFirst({ where: { readSessionId: id }, orderBy: { createdAt: "desc" } }),
    prisma.readSessionReview.findFirst({ where: { readSessionId: id }, orderBy: { updatedAt: "desc" } }),
    session.actionRecordId ? prisma.actionRecord.findUnique({ where: { id: session.actionRecordId } }) : Promise.resolve(null),
  ]);

  return {
    ...base,
    score: review?.score ?? base.score,
    notes: review?.notes ?? base.notes,
    feedItem: feedItem
      ? {
          id: feedItem.id,
          url: feedItem.url,
          title: feedItem.title,
          author: feedItem.author,
          rawContent: feedItem.rawContent,
          publishedAt: feedItem.publishedAt,
          seenAt: feedItem.seenAt,
          contentHash: feedItem.contentHash,
        }
      : null,
    thought: thought?.thought ?? null,
    rationale: rationale?.rationale ?? null,
    opportunityId: session.opportunityId,
    actionRecordId: session.actionRecordId,
    actionRecord: actionRecord ? mapActionRecord(actionRecord, undefined) : null,
  };
}

export async function getOpportunities(): Promise<RuntimeOpportunityRow[]> {
  const prisma = getPrisma();
  const opportunities = await prisma.opportunity.findMany({ orderBy: { createdAt: "desc" }, take: 80 });
  const sceneIds = [...new Set(opportunities.map((opportunity) => opportunity.sceneId))];
  const opportunityIds = opportunities.map((opportunity) => opportunity.id);
  const [scenes, decisions, intents] = await Promise.all([
    prisma.scene.findMany({ where: { id: { in: sceneIds } } }),
    prisma.decision.findMany({ where: { opportunityId: { in: opportunityIds } }, orderBy: { createdAt: "desc" } }),
    prisma.actionIntent.groupBy({ by: ["opportunityId"], where: { opportunityId: { in: opportunityIds } }, _count: { id: true } }),
  ]);
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
  const decisionByOpportunity = new Map(decisions.map((decision) => [decision.opportunityId, decision]));
  const intentCountByOpportunity = new Map(intents.map((row) => [row.opportunityId, row._count.id]));

  return opportunities.map((opportunity) => ({
    id: opportunity.id,
    sceneId: opportunity.sceneId,
    sceneLabel: sceneLabel(sceneById.get(opportunity.sceneId)),
    queueKind: opportunity.queueKind,
    opportunityType: opportunity.opportunityType,
    status: opportunity.status,
    priority: opportunity.priority,
    payloadPreview: jsonPreview(opportunity.payload),
    decisionVerdict: decisionByOpportunity.get(opportunity.id)?.verdict ?? null,
    actionIntentCount: intentCountByOpportunity.get(opportunity.id) ?? 0,
    createdAt: opportunity.createdAt,
    updatedAt: opportunity.updatedAt,
  }));
}

function mapActionRecord(
  action: {
    id: string;
    actionIntentId: string;
    actionType: string;
    targetSceneId: string;
    deliveryState: string;
    resultPayload: unknown;
    createdAt: Date;
    updatedAt: Date;
  },
  scene: { displayName: string | null; kind: string; externalId: string } | undefined,
): RuntimeActionRecordRow {
  return {
    id: action.id,
    actionIntentId: action.actionIntentId,
    actionType: action.actionType,
    targetSceneId: action.targetSceneId,
    sceneLabel: sceneLabel(scene),
    deliveryState: action.deliveryState,
    riskBand: barrierField(action.resultPayload, "riskBand"),
    effectMode: barrierField(action.resultPayload, "effectMode"),
    reason: barrierField(action.resultPayload, "reason"),
    resultPreview: jsonPreview(action.resultPayload),
    resultPayload: action.resultPayload,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  };
}

export async function getActionRecords(): Promise<RuntimeActionRecordRow[]> {
  const prisma = getPrisma();
  const actions = await prisma.actionRecord.findMany({ orderBy: { createdAt: "desc" }, take: 80 });
  const sceneIds = [...new Set(actions.map((action) => action.targetSceneId))];
  const scenes = await prisma.scene.findMany({ where: { id: { in: sceneIds } } });
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
  return actions.map((action) => mapActionRecord(action, sceneById.get(action.targetSceneId)));
}

export async function getSceneStates(): Promise<SceneStateRow[]> {
  const prisma = getPrisma();
  const scenes = await prisma.scene.findMany({ orderBy: { updatedAt: "desc" }, take: 100 });
  const sceneIds = scenes.map((scene) => scene.id);
  const [opportunityCounts, actionCounts] = await Promise.all([
    prisma.opportunity.groupBy({
      by: ["sceneId", "status"],
      where: { sceneId: { in: sceneIds } },
      _count: { id: true },
    }),
    prisma.actionRecord.groupBy({
      by: ["targetSceneId"],
      where: { targetSceneId: { in: sceneIds } },
      _count: { id: true },
    }),
  ]);

  const actionCountByScene = new Map(actionCounts.map((row) => [row.targetSceneId, row._count.id]));
  return scenes.map((scene) => {
    const counts = opportunityCounts.filter((row) => row.sceneId === scene.id);
    return {
      id: scene.id,
      kind: scene.kind,
      externalId: scene.externalId,
      displayName: scene.displayName,
      policyPreview: jsonPreview(scene.policy, 180),
      opportunityCount: counts.reduce((sum, row) => sum + row._count.id, 0),
      pendingOpportunityCount: counts
        .filter((row) => row.status === "pending")
        .reduce((sum, row) => sum + row._count.id, 0),
      actionCount: actionCountByScene.get(scene.id) ?? 0,
      lastUpdatedAt: scene.updatedAt,
    };
  });
}

/**
 * Phase 1.5 LLM trace 观测查询。
 * 列表: 按 sceneId 聚合最近 7 天的调用; 详情: 单 scene 最近 N 次调用 + verdict。
 */

export type TraceMessageRole = "user" | "model" | "tool_calls" | "tool_results" | "unknown";

export interface TraceMessage {
  role: TraceMessageRole;
  /** user/model 直接是 content; tool_* 是序列化预览 */
  content: string;
  /** 标记: summary head ([历史摘要] 开头的 user) / trigger ([当前要回复的消息] 开头) / window / system */
  marker: "summary_head" | "trigger" | "quoted" | "window" | "raw";
}

export interface LlmTraceDetail {
  id: number;
  sceneId: string | null;
  opportunityId: string | null;
  frameId: string | null;
  loopIndex: number | null;
  prefixHash: string | null;
  tailHash: string | null;
  inputHash: string | null;
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  tokenUsageState: string | null;
  model: string | null;
  durationMs: number;
  error: string | null;
  createdAt: Date;
  systemPrompt: string;
  /** 按位置切分的 history, 第 0 段是 prefix (system + summary head), 第 1 段是 tail */
  prefixMessages: TraceMessage[];
  tailMessages: TraceMessage[];
  /** 输出 (model 回的最终文本 / tool calls 序列化), 若有 */
  outputPreview: string | null;
}

function classifyMessage(message: { role?: unknown; content?: unknown }): TraceMessage {
  const rawRole = typeof message.role === "string" ? message.role : "unknown";
  const role: TraceMessageRole = rawRole === "user" || rawRole === "model" || rawRole === "tool_calls" || rawRole === "tool_results"
    ? rawRole
    : "unknown";
  const rawContent = typeof message.content === "string" ? message.content : JSON.stringify(message);
  let marker: TraceMessage["marker"] = "window";
  if (role === "user") {
    if (rawContent.startsWith("[历史摘要]")) marker = "summary_head";
    else if (rawContent.startsWith("[当前要回复的消息]")) marker = "trigger";
    else if (rawContent.startsWith("[被引用消息]")) marker = "quoted";
    else marker = "window";
  } else if (role === "model") {
    marker = "window";
  } else {
    marker = "raw";
  }
  return { role, content: rawContent, marker };
}

function parseHistory(input: unknown): TraceMessage[] {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const history = obj.history;
  if (!Array.isArray(history)) return [];
  return history.map((item) => classifyMessage((item ?? {}) as { role?: unknown; content?: unknown }));
}

function extractSystemPrompt(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  return typeof obj.systemPrompt === "string" ? obj.systemPrompt : "";
}

function extractOutputPreview(output: unknown): string | null {
  if (!output) return null;
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

export async function getLlmTraceById(traceId: number): Promise<LlmTraceDetail | null> {
  const prisma = getPrisma();
  const trace = await prisma.llmTrace.findUnique({ where: { id: traceId } });
  if (!trace) return null;

  const allMessages = parseHistory(trace.input);
  // prefix = system + 0 或 1 条 summary_head, tail = 剩余
  const firstNonSummaryIdx = allMessages.findIndex((m) => m.marker !== "summary_head");
  const splitIdx = firstNonSummaryIdx === -1 ? allMessages.length : firstNonSummaryIdx;
  const prefixMessages = allMessages.slice(0, splitIdx);
  const tailMessages = allMessages.slice(splitIdx);

  return {
    id: trace.id,
    sceneId: trace.sceneId,
    opportunityId: trace.opportunityId,
    frameId: trace.frameId,
    loopIndex: trace.loopIndex,
    prefixHash: trace.prefixHash,
    tailHash: trace.tailHash,
    inputHash: trace.inputHash,
    inputTokens: trace.inputTokens,
    cachedTokens: trace.cachedTokens,
    outputTokens: trace.outputTokens,
    tokenUsageState: trace.tokenUsageState,
    model: trace.model,
    durationMs: trace.durationMs,
    error: trace.error,
    createdAt: trace.createdAt,
    systemPrompt: extractSystemPrompt(trace.input),
    prefixMessages,
    tailMessages,
    outputPreview: extractOutputPreview(trace.output),
  };
}
const LLM_TRACE_WINDOW_DAYS = 7;
const LLM_TRACE_DETAIL_LIMIT = 30;

export async function getLlmTraceSceneList(): Promise<LlmTraceSceneSummary[]> {
  const prisma = getPrisma();
  const since = new Date(Date.now() - LLM_TRACE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const traces = await prisma.llmTrace.findMany({
    where: { createdAt: { gte: since }, sceneId: { not: null } },
    select: {
      sceneId: true,
      prefixHash: true,
      tokenUsageState: true,
      inputTokens: true,
      cachedTokens: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const bySceneId = new Map<string, {
    callCount: number;
    capturedCount: number;
    cacheHitCount: number;
    totalInputTokens: number;
    totalCachedTokens: number;
    prefixHashes: Set<string>;
    lastCallAt: Date;
  }>();

  for (const trace of traces) {
    if (!trace.sceneId) continue;
    let bucket = bySceneId.get(trace.sceneId);
    if (!bucket) {
      bucket = {
        callCount: 0,
        capturedCount: 0,
        cacheHitCount: 0,
        totalInputTokens: 0,
        totalCachedTokens: 0,
        prefixHashes: new Set(),
        lastCallAt: trace.createdAt,
      };
      bySceneId.set(trace.sceneId, bucket);
    }
    bucket.callCount += 1;
    if (trace.tokenUsageState === "captured") bucket.capturedCount += 1;
    if ((trace.cachedTokens ?? 0) > 0) bucket.cacheHitCount += 1;
    bucket.totalInputTokens += trace.inputTokens ?? 0;
    bucket.totalCachedTokens += trace.cachedTokens ?? 0;
    if (trace.prefixHash) bucket.prefixHashes.add(trace.prefixHash);
    if (trace.createdAt > bucket.lastCallAt) bucket.lastCallAt = trace.createdAt;
  }

  return [...bySceneId.entries()]
    .map(([sceneId, bucket]) => ({
      sceneId,
      callCount: bucket.callCount,
      capturedCount: bucket.capturedCount,
      cacheHitCount: bucket.cacheHitCount,
      totalInputTokens: bucket.totalInputTokens,
      totalCachedTokens: bucket.totalCachedTokens,
      avgCacheHitRatio: bucket.totalInputTokens === 0
        ? 0
        : bucket.totalCachedTokens / bucket.totalInputTokens,
      uniquePrefixHashes: bucket.prefixHashes.size,
      lastCallAt: bucket.lastCallAt,
    }))
    .sort((a, b) => b.lastCallAt.getTime() - a.lastCallAt.getTime());
}

export async function getLlmTraceSceneDetail(sceneId: string): Promise<LlmTraceSceneDetail | null> {
  const prisma = getPrisma();
  const traces = await prisma.llmTrace.findMany({
    where: { sceneId },
    orderBy: { createdAt: "desc" },
    take: LLM_TRACE_DETAIL_LIMIT,
    select: {
      id: true,
      loopIndex: true,
      prefixHash: true,
      inputHash: true,
      inputTokens: true,
      cachedTokens: true,
      outputTokens: true,
      tokenUsageState: true,
      model: true,
      durationMs: true,
      error: true,
      createdAt: true,
    },
  });
  if (traces.length === 0) return null;

  const recentCalls: LlmTraceCallRow[] = traces.map((trace) => ({
    id: trace.id,
    loopIndex: trace.loopIndex,
    prefixHash: trace.prefixHash,
    inputHash: trace.inputHash,
    inputTokens: trace.inputTokens,
    cachedTokens: trace.cachedTokens,
    outputTokens: trace.outputTokens,
    tokenUsageState: trace.tokenUsageState,
    model: trace.model,
    durationMs: trace.durationMs,
    error: trace.error,
    createdAt: trace.createdAt,
  }));

  // 聚合 summary (跟列表用同样口径)
  let capturedCount = 0;
  let cacheHitCount = 0;
  let totalInputTokens = 0;
  let totalCachedTokens = 0;
  const prefixHashes = new Set<string>();
  for (const trace of traces) {
    if (trace.tokenUsageState === "captured") capturedCount++;
    if ((trace.cachedTokens ?? 0) > 0) cacheHitCount++;
    totalInputTokens += trace.inputTokens ?? 0;
    totalCachedTokens += trace.cachedTokens ?? 0;
    if (trace.prefixHash) prefixHashes.add(trace.prefixHash);
  }
  const summary: LlmTraceSceneSummary = {
    sceneId,
    callCount: traces.length,
    capturedCount,
    cacheHitCount,
    totalInputTokens,
    totalCachedTokens,
    avgCacheHitRatio: totalInputTokens === 0 ? 0 : totalCachedTokens / totalInputTokens,
    uniquePrefixHashes: prefixHashes.size,
    lastCallAt: traces[0]?.createdAt ?? new Date(0),
  };

  // P0 verdict: 在最近 N 次调用范围内
  // - prefixStable: 不同的 prefix_hash 数 ≤ 2 (允许 1 次 compaction)
  // - cacheHit: 至少有一次 cached_tokens > 0
  // - captured: 至少一半的调用 token_usage_state = 'captured'
  const verdict = {
    prefixStable: prefixHashes.size > 0 && prefixHashes.size <= 2,
    cacheHit: cacheHitCount > 0,
    captured: traces.length > 0 && capturedCount * 2 >= traces.length,
  };

  return { sceneId, summary, recentCalls, verdict };
}
