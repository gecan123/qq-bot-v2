import { Prisma } from "./generated/prisma/client";
import { getPrisma } from "./prisma";
import {
  asRecord,
  getStringPath,
  jsonPreview,
  percentLabel,
  previewText,
  startOfShanghaiDay,
} from "./runtime-format";

export interface DashboardStat {
  label: string;
  value: number;
}

export interface ActivityItem {
  id: string;
  type: "event" | "opportunity" | "action" | "read" | "memory" | "spine";
  title: string;
  subtitle: string;
  status: string;
  href: string;
  createdAt: Date;
}

export interface RuntimeDashboard {
  todayStart: Date;
  stats: DashboardStat[];
  activity: ActivityItem[];
  reviewQueues: {
    pendingMemoryProposals: number;
    pendingSelfSpineProposals: number;
    unreviewedReadSessions: number;
  };
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
  memoryProposals: MemoryProposalRow[];
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

export interface MemoryProposalRow {
  id: string;
  agentId: string;
  proposalType: string;
  status: string;
  confidence: number | null;
  salience: number | null;
  sourcePreview: string;
  payloadPreview: string;
  payloadText: string;
  memoryItemId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MemoryProposalQueryRow {
  id: string;
  agentId: string;
  sourceRef: unknown;
  proposalType: string;
  payload: unknown;
  confidence: number | null;
  salience: number | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SelfSpineOverview {
  versions: Array<{
    id: string;
    agentId: string;
    version: number;
    status: string;
    sourceProposalId: string | null;
    changedSections: string[];
    snapshotPreview: string;
    diffPreview: string;
    createdAt: Date;
  }>;
  proposals: Array<{
    id: string;
    agentId: string;
    status: string;
    rationale: string;
    patchPreview: string;
    sourcePreview: string;
    reviewedBy: string | null;
    reviewedAt: Date | null;
    createdAt: Date;
  }>;
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

function sceneLabel(scene: { displayName: string | null; kind: string; externalId: string } | undefined): string {
  if (!scene) return "unknown scene";
  return scene.displayName ?? `${scene.kind}:${scene.externalId}`;
}

function barrierField(payload: unknown, key: "riskBand" | "effectMode" | "reason"): string | null {
  const direct = getStringPath(payload, ["barrierVerdict", key]);
  if (direct) return direct;
  return getStringPath(payload, [key]);
}

function activityStatus(status: string | null | undefined): string {
  return status ?? "recorded";
}

function memoryProposalSourceRefCondition(refs: {
  readSessionId: string;
  feedItemId: string;
  contentHash: string | null;
}): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];

  const addReference = (key: "readSessionId" | "feedItemId" | "contentHash", value: string | null | undefined) => {
    if (!value) return;
    const direct = JSON.stringify({ [key]: value });
    const nestedObject = JSON.stringify({ sourceRefs: { [key]: value } });
    const nestedArray = JSON.stringify({ sourceRefs: [{ [key]: value }] });

    conditions.push(Prisma.sql`source_ref @> CAST(${direct} AS jsonb)`);
    conditions.push(Prisma.sql`source_ref @> CAST(${nestedObject} AS jsonb)`);
    conditions.push(Prisma.sql`source_ref @> CAST(${nestedArray} AS jsonb)`);
  };

  addReference("readSessionId", refs.readSessionId);
  addReference("feedItemId", refs.feedItemId);
  addReference("contentHash", refs.contentHash);

  return Prisma.join(conditions, " OR ");
}

export async function getRuntimeDashboard(): Promise<RuntimeDashboard> {
  const prisma = getPrisma();
  const todayStart = startOfShanghaiDay();

  const [
    eventCount,
    opportunityCount,
    actionCount,
    readCount,
    memoryProposalCount,
    spineVersionCount,
    pendingMemoryProposals,
    pendingSelfSpineProposals,
    totalReadSessions,
    reviewedReadSessions,
    events,
    opportunities,
    actions,
    reads,
    memoryProposals,
    spineVersions,
  ] = await Promise.all([
    prisma.runtimeEvent.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.opportunity.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.actionRecord.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.readSession.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.memoryProposal.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.selfSpineVersion.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.memoryProposal.count({ where: { status: "proposed" } }),
    prisma.selfSpineUpdateProposal.count({ where: { status: "proposed" } }),
    prisma.readSession.count(),
    prisma.readSessionReview.groupBy({ by: ["readSessionId"] }),
    prisma.runtimeEvent.findMany({ where: { createdAt: { gte: todayStart } }, orderBy: { createdAt: "desc" }, take: 8 }),
    prisma.opportunity.findMany({ where: { createdAt: { gte: todayStart } }, orderBy: { createdAt: "desc" }, take: 8 }),
    prisma.actionRecord.findMany({ where: { createdAt: { gte: todayStart } }, orderBy: { createdAt: "desc" }, take: 8 }),
    prisma.readSession.findMany({ where: { createdAt: { gte: todayStart } }, orderBy: { createdAt: "desc" }, take: 8 }),
    prisma.memoryProposal.findMany({ where: { createdAt: { gte: todayStart } }, orderBy: { createdAt: "desc" }, take: 8 }),
    prisma.selfSpineVersion.findMany({ where: { createdAt: { gte: todayStart } }, orderBy: { createdAt: "desc" }, take: 8 }),
  ]);

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
    ...memoryProposals.map((proposal) => ({
      id: proposal.id,
      type: "memory" as const,
      title: proposal.proposalType,
      subtitle: percentLabel(proposal.confidence),
      status: activityStatus(proposal.status),
      href: "/memory-proposals",
      createdAt: proposal.createdAt,
    })),
    ...spineVersions.map((version) => ({
      id: version.id,
      type: "spine" as const,
      title: `Self Spine v${version.version}`,
      subtitle: version.agentId,
      status: activityStatus(version.status),
      href: "/self-spine",
      createdAt: version.createdAt,
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
      { label: "Memory Proposals", value: memoryProposalCount },
      { label: "Spine Versions", value: spineVersionCount },
    ],
    activity,
    reviewQueues: {
      pendingMemoryProposals,
      pendingSelfSpineProposals,
      unreviewedReadSessions: Math.max(0, totalReadSessions - reviewedReadSessions.length),
    },
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
  const sourceRefCondition = memoryProposalSourceRefCondition({
    readSessionId: id,
    feedItemId: session.feedItemId,
    contentHash: session.contentHash,
  });

  const [feedItem, summary, thought, rationale, review, actionRecord, memoryProposals] = await Promise.all([
    prisma.feedItem.findUnique({ where: { id: session.feedItemId } }),
    prisma.sourceSummary.findFirst({ where: { readSessionId: id }, orderBy: { createdAt: "desc" } }),
    prisma.thoughtArtifact.findFirst({ where: { readSessionId: id }, orderBy: { createdAt: "desc" } }),
    prisma.rationaleArtifact.findFirst({ where: { readSessionId: id }, orderBy: { createdAt: "desc" } }),
    prisma.readSessionReview.findFirst({ where: { readSessionId: id }, orderBy: { updatedAt: "desc" } }),
    session.actionRecordId ? prisma.actionRecord.findUnique({ where: { id: session.actionRecordId } }) : Promise.resolve(null),
    prisma.$queryRaw<MemoryProposalQueryRow[]>(Prisma.sql`
      SELECT
        id,
        agent_id AS "agentId",
        source_ref AS "sourceRef",
        proposal_type AS "proposalType",
        payload,
        confidence,
        salience,
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM memory_proposals
      WHERE ${sourceRefCondition}
      ORDER BY created_at DESC
    `),
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
    memoryProposals: memoryProposals.map((proposal) => mapMemoryProposal(proposal, null)),
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

function mapMemoryProposal(
  proposal: {
    id: string;
    agentId: string;
    sourceRef: unknown;
    proposalType: string;
    payload: unknown;
    confidence: number | null;
    salience: number | null;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  },
  memoryItemId: string | null,
): MemoryProposalRow {
  return {
    id: proposal.id,
    agentId: proposal.agentId,
    proposalType: proposal.proposalType,
    status: proposal.status,
    confidence: proposal.confidence,
    salience: proposal.salience,
    sourcePreview: jsonPreview(proposal.sourceRef),
    payloadPreview: jsonPreview(proposal.payload, 260),
    payloadText: JSON.stringify(proposal.payload, null, 2),
    memoryItemId,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
  };
}

export async function getMemoryProposals(): Promise<MemoryProposalRow[]> {
  const prisma = getPrisma();
  const proposals = await prisma.memoryProposal.findMany({ orderBy: { createdAt: "desc" }, take: 80 });
  const proposalIds = proposals.map((proposal) => proposal.id);
  const items = await prisma.memoryItem.findMany({
    where: { sourceProposalId: { in: proposalIds } },
    select: { id: true, sourceProposalId: true },
  });
  const itemByProposal = new Map(items.map((item) => [item.sourceProposalId, item.id]));
  return proposals.map((proposal) => mapMemoryProposal(proposal, itemByProposal.get(proposal.id) ?? null));
}

export async function getSelfSpineOverview(): Promise<SelfSpineOverview> {
  const prisma = getPrisma();
  const [versions, proposals] = await Promise.all([
    prisma.selfSpineVersion.findMany({ orderBy: [{ agentId: "asc" }, { version: "desc" }], take: 50 }),
    prisma.selfSpineUpdateProposal.findMany({ orderBy: { createdAt: "desc" }, take: 80 }),
  ]);

  return {
    versions: versions.map((version) => ({
      id: version.id,
      agentId: version.agentId,
      version: version.version,
      status: version.status,
      sourceProposalId: version.sourceProposalId,
      changedSections: Array.isArray(asRecord(version.diff).changedSections)
        ? (asRecord(version.diff).changedSections as unknown[]).filter((item): item is string => typeof item === "string")
        : Object.keys(asRecord(asRecord(version.diff).patch)),
      snapshotPreview: jsonPreview(version.snapshot, 260),
      diffPreview: jsonPreview(version.diff, 260),
      createdAt: version.createdAt,
    })),
    proposals: proposals.map((proposal) => ({
      id: proposal.id,
      agentId: proposal.agentId,
      status: proposal.status,
      rationale: proposal.rationale,
      patchPreview: jsonPreview(proposal.patch, 260),
      sourcePreview: jsonPreview(proposal.sourceRef, 180),
      reviewedBy: proposal.reviewedBy,
      reviewedAt: proposal.reviewedAt,
      createdAt: proposal.createdAt,
    })),
  };
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
