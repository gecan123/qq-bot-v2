"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { Prisma } from "./generated/prisma/client";
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

function asJsonObject(value: Prisma.JsonValue): Prisma.InputJsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Prisma.InputJsonObject)
    : {};
}

function parseEditedPayload(raw: string | null): Prisma.InputJsonObject {
  if (!raw) throw new Error("edited payload is required");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("edited payload must be a JSON object");
  }
  return parsed as Prisma.InputJsonObject;
}

const SELF_SPINE_SECTIONS = new Set([
  "identity",
  "expression_style",
  "long_term_interests",
  "values",
  "tool_boundaries",
  "long_term_goals",
  "important_memory_summary",
  "scene_preferences",
  "prohibitions",
]);

function assertSelfSpinePatch(patch: Prisma.InputJsonObject): void {
  const sections = Object.keys(patch);
  if (sections.length === 0) throw new Error("self spine patch must include at least one section");
  for (const section of sections) {
    if (!SELF_SPINE_SECTIONS.has(section)) {
      throw new Error(`unsupported self spine section: ${section}`);
    }
  }
}

function sourceRefsFrom(sourceRef: Prisma.InputJsonObject): Prisma.InputJsonObject[] {
  const refs = sourceRef.sourceRefs;
  if (!Array.isArray(refs)) return [];
  return refs.filter((ref): ref is Prisma.InputJsonObject => Boolean(ref) && typeof ref === "object" && !Array.isArray(ref));
}

function sourceIdentity(ref: Prisma.InputJsonObject): string | null {
  if (ref.messageRowId !== undefined) return `messageRowId:${String(ref.messageRowId)}`;
  if (ref.messageId !== undefined) return `messageId:${String(ref.messageId)}`;
  if (ref.feedItemId !== undefined) return `feedItemId:${String(ref.feedItemId)}`;
  if (ref.actionRecordId !== undefined) return `actionRecordId:${String(ref.actionRecordId)}`;
  if (ref.readSessionId !== undefined) return `readSessionId:${String(ref.readSessionId)}`;
  return null;
}

function distinctSourceRefCount(refs: Prisma.InputJsonObject[]): number {
  const identities = new Set<string>();
  for (const ref of refs) {
    const identity = sourceIdentity(ref);
    if (identity) identities.add(identity);
  }
  return identities.size;
}

function assertSelfSpineSourceCanMutate(sourceRef: Prisma.InputJsonObject): void {
  const basis = typeof sourceRef.basis === "string" ? sourceRef.basis : "";
  if (basis === "single_message" || basis === "single_forum_post") {
    throw new Error(`single-source ${basis} must not directly mutate Self Spine`);
  }

  const refs = sourceRefsFrom(sourceRef);
  const distinctRefCount = distinctSourceRefCount(refs);
  if (basis === "aggregate_review" && distinctRefCount < 2) {
    throw new Error("aggregate Self Spine update requires multiple distinct source refs");
  }
  if (refs.length === 0 && basis !== "manual_review" && basis !== "maintenance_review") {
    throw new Error("self spine update requires review basis or aggregate source refs");
  }
  if (distinctRefCount !== 1) return;

  const onlyRef = refs[0] ?? {};
  const explicitReviewBasis = basis === "manual_review" || basis === "maintenance_review" || basis === "aggregate_review";
  const directMessageRef = onlyRef.messageRowId !== undefined || onlyRef.messageId !== undefined;
  const directForumRef = onlyRef.feedItemId !== undefined;
  if (!explicitReviewBasis && (directMessageRef || directForumRef)) {
    throw new Error("single message or single forum post must not directly mutate Self Spine");
  }
}

function mergeJsonPatch(base: Prisma.InputJsonObject, patch: Prisma.InputJsonObject): Prisma.InputJsonObject {
  const out: Record<string, Prisma.InputJsonValue | null> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) out[key] = value;
  }
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out[key] = mergeJsonPatch(existing as Prisma.InputJsonObject, value as Prisma.InputJsonObject);
    } else {
      out[key] = value as Prisma.InputJsonValue | null;
    }
  }
  return out as Prisma.InputJsonObject;
}

export async function reviewMemoryProposalAction(formData: FormData): Promise<void> {
  const proposalId = requiredString(formData, "proposalId");
  const verdict = requiredString(formData, "verdict");
  const prisma = getPrisma();

  if (verdict === "reject") {
    const result = await prisma.memoryProposal.updateMany({
      where: { id: proposalId, status: "proposed" },
      data: { status: "rejected" },
    });
    if (result.count !== 1) throw new Error(`memory proposal is not reviewable: ${proposalId}`);
  } else if (verdict === "accept" || verdict === "edit_accept") {
    const scope = optionalString(formData, "scope") ?? "global";
    const editedPayload = verdict === "edit_accept" ? parseEditedPayload(optionalString(formData, "payload")) : null;
    await prisma.$transaction(async (tx) => {
      const proposal = await tx.memoryProposal.findUnique({ where: { id: proposalId } });
      if (!proposal) throw new Error(`memory proposal not found: ${proposalId}`);
      if (proposal.status !== "proposed") {
        throw new Error(`memory proposal is not reviewable: ${proposalId}:${proposal.status}`);
      }

      await tx.memoryItem.upsert({
        where: { sourceProposalId: proposal.id },
        update: {},
        create: {
          id: stableId("memory-item", `${proposal.agentId}:${proposal.id}`),
          agentId: proposal.agentId,
          scope,
          memoryType: proposal.proposalType,
          sourceRef: asJsonObject(proposal.sourceRef),
          sourceProposalId: proposal.id,
          payload: editedPayload ?? asJsonObject(proposal.payload),
          confidence: proposal.confidence,
          salience: proposal.salience,
          status: "active",
          decayPolicy: proposal.decayPolicy ?? Prisma.JsonNull,
          expiresAt: proposal.expiresAt,
          acceptedAt: new Date(),
        },
      });

      await tx.memoryProposal.update({
        where: { id: proposal.id },
        data: editedPayload ? { status: "accepted", payload: editedPayload } : { status: "accepted" },
      });
    });
  } else {
    throw new Error(`unsupported memory review verdict: ${verdict}`);
  }

  revalidatePath("/memory-proposals");
  revalidatePath("/reading-sessions");
  revalidatePath("/");
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

export async function reviewSelfSpineProposalAction(formData: FormData): Promise<void> {
  const proposalId = requiredString(formData, "proposalId");
  const verdict = requiredString(formData, "verdict");
  const reviewedBy = optionalString(formData, "reviewedBy") ?? "admin";
  const reviewedAt = new Date();
  const prisma = getPrisma();

  if (verdict === "reject") {
    const result = await prisma.selfSpineUpdateProposal.updateMany({
      where: { id: proposalId, status: "proposed" },
      data: { status: "rejected", reviewedBy, reviewedAt },
    });
    if (result.count !== 1) throw new Error(`self spine proposal is not reviewable: ${proposalId}`);
  } else if (verdict === "accept") {
    await prisma.$transaction(async (tx) => {
      const proposal = await tx.selfSpineUpdateProposal.findUnique({ where: { id: proposalId } });
      if (!proposal) throw new Error(`self spine update proposal not found: ${proposalId}`);
      if (proposal.status !== "proposed") {
        throw new Error(`self spine proposal is not reviewable: ${proposal.id}:${proposal.status}`);
      }

      const sourceRef = asJsonObject(proposal.sourceRef);
      const patch = asJsonObject(proposal.patch);
      assertSelfSpineSourceCanMutate(sourceRef);
      assertSelfSpinePatch(patch);

      const existingVersion = await tx.selfSpineVersion.findFirst({ where: { sourceProposalId: proposal.id } });
      if (existingVersion) {
        await tx.selfSpineUpdateProposal.update({
          where: { id: proposal.id },
          data: { status: "accepted", reviewedBy, reviewedAt },
        });
        return;
      }

      const latest = await tx.selfSpineVersion.findFirst({
        where: { agentId: proposal.agentId, status: "active" },
        orderBy: { version: "desc" },
      });
      const previousSnapshot = latest ? asJsonObject(latest.snapshot) : {};
      const nextVersion = (latest?.version ?? 0) + 1;
      const snapshot = mergeJsonPatch(previousSnapshot, patch);

      await tx.selfSpineVersion.updateMany({
        where: { agentId: proposal.agentId, status: "active" },
        data: { status: "superseded" },
      });
      await tx.selfSpineVersion.create({
        data: {
          id: stableId("self-spine-version", `${proposal.agentId}:${nextVersion}`),
          agentId: proposal.agentId,
          version: nextVersion,
          snapshot,
          diff: {
            previousVersion: latest?.version ?? null,
            changedSections: Object.keys(patch),
            patch,
            rationale: proposal.rationale,
            reviewedBy,
          },
          sourceProposalId: proposal.id,
          status: "active",
        },
      });
      await tx.selfSpineUpdateProposal.update({
        where: { id: proposal.id },
        data: { status: "accepted", reviewedBy, reviewedAt },
      });
    });
  } else {
    throw new Error(`unsupported self spine review verdict: ${verdict}`);
  }

  revalidatePath("/self-spine");
  revalidatePath("/");
}
