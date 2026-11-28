import { Global, Module } from '@nestjs/common';
import { AdminAuditLogsController } from './admin-audit-logs.controller';
import { AuditLogService } from './audit-log.service';
import { AuditLogsQueryService } from './audit-logs-query.service';

// AuditLogService は各業務Serviceが業務更新と同じトランザクション内で呼ぶため、
// グローバルに公開する。
@Global()
@Module({
  controllers: [AdminAuditLogsController],
  providers: [AuditLogService, AuditLogsQueryService],
  exports: [AuditLogService],
})
export class AuditModule {}
