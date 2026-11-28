import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { RoleName, type AuditLogListResponseDto } from '@expense/shared';
import { RoleGuard } from '../admin/role.guard';
import { Roles } from '../admin/roles.decorator';
import { AuditLogsQueryService } from './audit-logs-query.service';
import { AuditLogListQueryDto } from './dto/audit-log-list-query.dto';

// PBI6: 監査ログの閲覧API。ADMINロールだけ（ロールはGuardで判定。横断ルール1）。
// GETだけを実装する。作成・更新・削除のルートは作らない（監査ログは業務操作の副作用としてだけ生まれる）。
@UseGuards(RoleGuard)
@Roles(RoleName.ADMIN)
@Controller('admin/audit-logs')
export class AdminAuditLogsController {
  constructor(private readonly queryService: AuditLogsQueryService) {}

  @Get()
  async list(
    @Query() query: AuditLogListQueryDto,
  ): Promise<AuditLogListResponseDto> {
    return this.queryService.list(query);
  }
}
