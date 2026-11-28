import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AUDIT_LOG_PAGE_SIZE,
  type AuditAction,
  type AuditFailureCode,
  type AuditLogDto,
  type AuditLogListResponseDto,
  type AuditResult,
  type AuditSnapshot,
  type AuditTargetType,
} from '@expense/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogListQueryDto } from './dto/audit-log-list-query.dto';

// 返す列を明示的に選ぶ（将来列が増えても自動で露出しない）。
const AUDIT_LOG_SELECT = {
  id: true,
  occurredAt: true,
  actorUserId: true,
  actorEmail: true,
  action: true,
  result: true,
  failureCode: true,
  targetType: true,
  targetId: true,
  before: true,
  after: true,
  ipAddress: true,
} satisfies Prisma.AuditLogSelect;

/**
 * 監査ログの閲覧（管理者のみ。ロールはController側のGuardで判定）。
 * 読み取り専用。このクラスから更新・削除は行わない。
 */
@Injectable()
export class AuditLogsQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AuditLogListQueryDto): Promise<AuditLogListResponseDto> {
    const page = query.page ?? 1;

    // 絞り込みはすべてAND条件でPrismaにバインドする（文字列結合しない）。
    // actorEmail は完全一致（mode: 'insensitive' を付けない＝大文字小文字も区別）。
    const occurredAt: Prisma.DateTimeFilter = {};
    if (query.from) occurredAt.gte = new Date(query.from);
    if (query.to) occurredAt.lt = new Date(query.to);

    const where: Prisma.AuditLogWhereInput = {
      ...(query.actorUserId !== undefined && {
        actorUserId: query.actorUserId,
      }),
      ...(query.actorEmail !== undefined && { actorEmail: query.actorEmail }),
      ...(query.targetType !== undefined && { targetType: query.targetType }),
      ...(query.targetId !== undefined && { targetId: query.targetId }),
      ...(query.from || query.to ? { occurredAt } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        select: AUDIT_LOG_SELECT,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * AUDIT_LOG_PAGE_SIZE,
        take: AUDIT_LOG_PAGE_SIZE,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      items: rows.map((row): AuditLogDto => ({
        id: row.id,
        occurredAt: row.occurredAt.toISOString(),
        actorUserId: row.actorUserId,
        actorEmail: row.actorEmail,
        action: row.action as AuditAction,
        result: row.result as AuditResult,
        failureCode: row.failureCode as AuditFailureCode | null,
        targetType: row.targetType as AuditTargetType,
        targetId: row.targetId,
        before: row.before as AuditSnapshot | null,
        after: row.after as AuditSnapshot | null,
        ipAddress: row.ipAddress,
      })),
      total,
      page,
      pageSize: AUDIT_LOG_PAGE_SIZE,
    };
  }
}
