-- MVP-2 multi-source migration
--
-- 1) Drop llm_traces entirely (D7 + D12): zero application consumers.
-- 2) Make messages.group_id nullable so private messages can be persisted in the
--    same ledger (sceneKind='qq_private', groupId=null, sceneExternalId=peerId).

DROP TABLE IF EXISTS "llm_traces";

ALTER TABLE "messages" ALTER COLUMN "group_id" DROP NOT NULL;
