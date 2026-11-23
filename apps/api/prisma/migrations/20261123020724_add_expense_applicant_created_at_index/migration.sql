-- DropIndex
DROP INDEX "expense_requests_applicantId_idx";

-- CreateIndex
CREATE INDEX "expense_requests_applicantId_createdAt_idx" ON "expense_requests"("applicantId", "createdAt");
