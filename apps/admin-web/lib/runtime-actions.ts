"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { getPrisma } from "./prisma";

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function requiredString(formData: FormData, key: string): string {
  const value = formData.get(key);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function optionalString(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function upsertReadSessionReviewAction(formData: FormData): Promise<void> {
  const readSessionId = requiredString(formData, "readSessionId");
  const reviewer = optionalString(formData, "reviewer") ?? "admin";
  const scoreValue = optionalString(formData, "score");
  const parsedScore = scoreValue === null ? Number.NaN : Number.parseInt(scoreValue, 10);
  const score = Number.isNaN(parsedScore) ? null : Math.max(1, Math.min(5, parsedScore));
  const notes = optionalString(formData, "notes");
  const prisma = getPrisma();

  const readSession = await prisma.readSession.findUnique({
    where: { id: readSessionId },
    select: { id: true },
  });
  if (!readSession) throw new Error(`read session not found: ${readSessionId}`);

  await prisma.readSessionReview.upsert({
    where: { readSessionId_reviewer: { readSessionId, reviewer } },
    update: { score, notes },
    create: {
      id: stableId("read-session-review", `${readSessionId}:${reviewer}`),
      readSessionId,
      reviewer,
      score,
      notes,
    },
  });

  revalidatePath("/reading-sessions");
  revalidatePath(`/reading-sessions/${readSessionId}`);
}
