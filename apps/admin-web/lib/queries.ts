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
