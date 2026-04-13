import type { ParsedSegment } from "./message-segments";
import { prisma } from "./prisma";

function serializeBigInt<T>(obj: T): T {
  return JSON.parse(
    JSON.stringify(obj, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    )
  );
}

export interface GroupSummary {
  groupId: string;
  groupName: string | null;
  messageCount: number;
  lastMessageAt: Date;
}

export async function getGroups(): Promise<GroupSummary[]> {
  const rows = await prisma.message.groupBy({
    by: ["groupId", "groupName"],
    _count: { id: true },
    _max: { createdAt: true },
    orderBy: { _max: { createdAt: "desc" } },
  });

  return rows.map((row) => ({
    groupId: row.groupId.toString(),
    groupName: row.groupName,
    messageCount: row._count.id,
    lastMessageAt: row._max.createdAt!,
  }));
}

export interface MessageRow {
  id: number;
  groupId: string;
  messageId: string;
  senderId: string;
  senderNickname: string | null;
  senderGroupNickname: string | null;
  content: ParsedSegment[];
  resolvedText: string | null;
  sentAt: Date | null;
  createdAt: Date;
}

export async function getGroupMessages(
  groupId: string,
  page: number,
  pageSize = 50,
  search?: string
): Promise<{ messages: MessageRow[]; total: number }> {
  const groupIdBig = BigInt(groupId);
  const where = search
    ? { groupId: groupIdBig, searchText: { contains: search, mode: "insensitive" as const } }
    : { groupId: groupIdBig };

  const [messages, total] = await Promise.all([
    prisma.message.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        groupId: true,
        messageId: true,
        senderId: true,
        senderNickname: true,
        senderGroupNickname: true,
        content: true,
        resolvedText: true,
        sentAt: true,
        createdAt: true,
      },
    }),
    prisma.message.count({ where }),
  ]);

  return {
    messages: serializeBigInt(messages) as unknown as MessageRow[],
    total,
  };
}

export interface GroupMemoryRow {
  groupId: string;
  groupName: string | null;
  summary: string;
  updatedAt: Date;
}

export async function getGroupMemory(
  groupId: string
): Promise<GroupMemoryRow | null> {
  const row = await prisma.groupMemory.findUnique({
    where: { groupId: BigInt(groupId) },
  });

  if (!row) {
    return null;
  }

  return serializeBigInt(row) as unknown as GroupMemoryRow;
}

export interface UserMemoryRow {
  id: number;
  groupId: string;
  senderId: string;
  senderNickname: string | null;
  senderGroupNickname: string | null;
  profile: string;
  examples: string[];
  updatedAt: Date;
}

export async function getUserMemories(groupId: string): Promise<UserMemoryRow[]> {
  const rows = await prisma.userMemory.findMany({
    where: { groupId: BigInt(groupId) },
    orderBy: { updatedAt: "desc" },
  });

  return serializeBigInt(rows) as unknown as UserMemoryRow[];
}

export interface GroupMemoryCursorRow {
  groupId: string;
  lastProcessedExternalMessageId: string;
  lastProcessedMessageRowId: number;
  updatedAt: Date;
}

export async function getGroupMemoryCursor(
  groupId: string
): Promise<GroupMemoryCursorRow | null> {
  const row = await prisma.groupMemoryCursor.findUnique({
    where: { groupId: BigInt(groupId) },
  });

  if (!row) return null;
  return serializeBigInt(row) as unknown as GroupMemoryCursorRow;
}

export interface MediaMeta {
  mediaId: number;
  dataHash: string | null;
  mediaType: string | null;
  contentType: string | null;
  fileName: string | null;
  fileSize: number | null;
  descriptionRaw: unknown | null;
  createdAt: Date;
}

export async function getMediaCount(): Promise<number> {
  return prisma.media.count();
}

export async function getMediaList(
  page: number,
  pageSize = 48
): Promise<{ items: MediaMeta[]; total: number }> {
  const [items, total] = await Promise.all([
    prisma.media.findMany({
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        mediaId: true,
        dataHash: true,
        mediaType: true,
        contentType: true,
        fileName: true,
        fileSize: true,
        descriptionRaw: true,
        createdAt: true,
      },
    }),
    prisma.media.count(),
  ]);

  return { items, total };
}

export interface LlmTraceListRow {
  id: number;
  groupId: string;
  model: string | null;
  durationMs: number;
  error: string | null;
  createdAt: Date;
  systemPromptPreview: string;
  historyCount: number;
}

export async function getLlmTraceList(
  page: number,
  pageSize = 20
): Promise<{ items: LlmTraceListRow[]; total: number }> {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 20;
  const offset = (safePage - 1) * safePageSize;

  const [items, totalRows] = await Promise.all([
    prisma.$queryRaw<
      Array<{
        id: number;
        group_id: bigint;
        model: string | null;
        duration_ms: number;
        error: string | null;
        created_at: Date;
        system_prompt_preview: string | null;
        history_count: number | null;
      }>
    >`
      SELECT
        id,
        group_id,
        model,
        duration_ms,
        error,
        created_at,
        LEFT(COALESCE(input->>'systemPrompt', ''), 120) AS system_prompt_preview,
        COALESCE(JSONB_ARRAY_LENGTH(CASE
          WHEN JSONB_TYPEOF(input::jsonb->'history') = 'array' THEN input::jsonb->'history'
          ELSE '[]'::jsonb
        END), 0) AS history_count
      FROM llm_traces
      ORDER BY created_at DESC
      LIMIT ${safePageSize}
      OFFSET ${offset}
    `,
    prisma.$queryRaw<Array<{ total: bigint }>>`SELECT COUNT(*)::bigint AS total FROM llm_traces`,
  ]);

  return {
    items: items.map((row) => ({
      id: row.id,
      groupId: row.group_id.toString(),
      model: row.model,
      durationMs: row.duration_ms,
      error: row.error,
      createdAt: row.created_at,
      systemPromptPreview: row.system_prompt_preview ?? "",
      historyCount: row.history_count ?? 0,
    })),
    total: Number(totalRows[0]?.total ?? BigInt(0)),
  };
}
