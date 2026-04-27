ALTER TABLE "action_intents" ALTER COLUMN "risk_level" SET DEFAULT 'persistence';

UPDATE "action_intents"
SET "risk_level" = CASE
    WHEN "risk_level" = 'L0' THEN 'internal'
    WHEN "risk_level" = 'L1' THEN 'persistence'
    WHEN "risk_level" = 'L2' THEN 'private_reply'
    WHEN "risk_level" = 'L3' AND "action_type" = 'send_group_message' THEN 'ambient_group_post'
    WHEN "risk_level" = 'L3' AND "action_type" IN ('reply_to_message', 'send_group_reply') THEN 'anchored_group_reply'
    WHEN "risk_level" = 'L3' THEN 'anchored_group_reply'
    WHEN "risk_level" = 'L4' THEN 'public_post'
    ELSE "risk_level"
END;

UPDATE "decisions"
SET "risk_level" = CASE
    WHEN "risk_level" = 'L0' THEN 'internal'
    WHEN "risk_level" = 'L1' THEN 'persistence'
    WHEN "risk_level" = 'L2' THEN 'private_reply'
    WHEN "risk_level" = 'L3' AND "barrier_input"->>'actionType' = 'send_group_message' THEN 'ambient_group_post'
    WHEN "risk_level" = 'L3' AND "barrier_input"->>'actionType' IN ('reply_to_message', 'send_group_reply') THEN 'anchored_group_reply'
    WHEN "risk_level" = 'L3' THEN 'anchored_group_reply'
    WHEN "risk_level" = 'L4' THEN 'public_post'
    ELSE "risk_level"
END;
