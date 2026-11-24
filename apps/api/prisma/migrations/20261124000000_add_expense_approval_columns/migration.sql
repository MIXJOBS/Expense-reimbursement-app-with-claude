-- AlterTable
ALTER TABLE "expense_requests" ADD COLUMN     "approverId" UUID,
ADD COLUMN     "returnReason" VARCHAR(500);

-- CreateIndex
CREATE INDEX "expense_requests_approverId_status_idx" ON "expense_requests"("approverId", "status");

-- AddForeignKey
ALTER TABLE "expense_requests" ADD CONSTRAINT "expense_requests_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

