-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "actorUserId" UUID,
    "actorEmail" VARCHAR(254),
    "action" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "failureCode" TEXT,
    "targetType" TEXT NOT NULL,
    "targetId" UUID,
    "before" JSONB,
    "after" JSONB,
    "ipAddress" VARCHAR(45),

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_occurredAt_idx" ON "audit_logs"("occurredAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorUserId_occurredAt_idx" ON "audit_logs"("actorUserId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorEmail_occurredAt_idx" ON "audit_logs"("actorEmail", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_logs_targetType_targetId_occurredAt_idx" ON "audit_logs"("targetType", "targetId", "occurredAt");


-- ============================================================
-- 追記専用の担保（手書きSQL。Prismaのスキーマではトリガーを表現できないため）
-- docs/api/pbi-6.md「追記専用の担保」
-- audit_logs への UPDATE・DELETE・TRUNCATE を、アプリ・手動SQLを問わず拒否する。
-- INSERT だけが許可される。
-- ============================================================
CREATE FUNCTION audit_logs_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (% is not allowed)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

-- 行単位：UPDATE・DELETE
CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_reject_mutation();

-- 文単位：TRUNCATE（行単位トリガーは TRUNCATE では発火しないため別に必要）
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_reject_mutation();
