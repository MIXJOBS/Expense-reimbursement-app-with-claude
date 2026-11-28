import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ExpenseRequest, Prisma } from '@prisma/client';
import {
  AuditAction,
  AuditResult,
  AuditTargetType,
  APPROVAL_LIST_MAX_ITEMS,
  ErrorCode,
  ExpenseStatus,
  EXPENSE_APPROVABLE_STATUSES,
  EXPENSE_APPROVER_VISIBLE_STATUSES,
  EXPENSE_RETURNABLE_STATUSES,
  type ApprovalListResponseDto,
  type ExpenseRequestDto,
} from '@expense/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * 承認対象の一覧。approverId=自分・申請者が自分でない・SUBMITTEDのみ。
   * ページネーションなし、createdAt降順で最大APPROVAL_LIST_MAX_ITEMS件。
   */
  async list(approverId: string): Promise<ApprovalListResponseDto> {
    const items = await this.prisma.expenseRequest.findMany({
      where: {
        approverId,
        applicantId: { not: approverId },
        status: { in: EXPENSE_APPROVER_VISIBLE_STATUSES },
      },
      orderBy: { createdAt: 'desc' },
      take: APPROVAL_LIST_MAX_ITEMS,
    });
    return { items: items.map((item) => this.toDto(item)) };
  }

  /** 詳細。一覧と同じ絞り込み条件を where に含める（該当しなければ404）。 */
  async findOne(approverId: string, id: string): Promise<ExpenseRequestDto> {
    const expense = await this.prisma.expenseRequest.findFirst({
      where: {
        id,
        approverId,
        applicantId: { not: approverId },
        status: { in: EXPENSE_APPROVER_VISIBLE_STATUSES },
      },
    });
    if (!expense) {
      throw this.notFound();
    }
    return this.toDto(expense);
  }

  /**
   * 承認。2段階方式：
   * 1. 申請行をロックして読む（approverId・applicantId not self が条件）→ 無ければ404。
   * 2. status条件つきupdateMany。0件なら409（同時実行の敗者を含む。Txごとロールバック）。
   * 更新と監査ログは同一トランザクション。
   */
  async approve(
    approverId: string,
    id: string,
    ipAddress: string | null,
  ): Promise<ExpenseRequestDto> {
    return this.transition({
      approverId,
      id,
      ipAddress,
      action: AuditAction.EXPENSE_APPROVE,
      allowedStatuses: EXPENSE_APPROVABLE_STATUSES,
      data: { status: ExpenseStatus.APPROVED },
    });
  }

  /** 差し戻し。statusとreturnReasonは単一のUPDATEで同時に書く。 */
  async returnRequest(
    approverId: string,
    id: string,
    reason: string,
    ipAddress: string | null,
  ): Promise<ExpenseRequestDto> {
    return this.transition({
      approverId,
      id,
      ipAddress,
      action: AuditAction.EXPENSE_RETURN,
      allowedStatuses: EXPENSE_RETURNABLE_STATUSES,
      data: { status: ExpenseStatus.RETURNED, returnReason: reason },
    });
  }

  private async transition(p: {
    approverId: string;
    id: string;
    ipAddress: string | null;
    action:
      typeof AuditAction.EXPENSE_APPROVE | typeof AuditAction.EXPENSE_RETURN;
    allowedStatuses: ExpenseStatus[];
    data: Prisma.ExpenseRequestUpdateManyMutationInput;
  }): Promise<ExpenseRequestDto> {
    const { approverId, id } = p;
    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await this.lockAssigned(tx, approverId, id);
      if (!existing) {
        throw this.notFound();
      }

      const result = await tx.expenseRequest.updateMany({
        where: {
          id,
          approverId,
          applicantId: { not: approverId },
          status: { in: p.allowedStatuses },
        },
        data: p.data,
      });
      if (result.count === 0) {
        throw this.conflictInvalidStatus();
      }

      // 更新後は status がSUBMITTEDでなくなっているため、findOneの絞り込みは使わない。
      const after = await tx.expenseRequest.findFirst({
        where: { id, approverId, applicantId: { not: approverId } },
      });
      if (!after) {
        throw this.notFound();
      }

      await this.auditLog.record(tx, {
        actorUserId: approverId,
        action: p.action,
        result: AuditResult.SUCCESS,
        targetType: AuditTargetType.EXPENSE_REQUEST,
        targetId: id,
        before: this.auditLog.expenseSnapshot(existing),
        after: this.auditLog.expenseSnapshot(after),
        ipAddress: p.ipAddress,
      });
      return after;
    });
    return this.toDto(updated);
  }

  // 担当している（approverId=自分・申請者は自分でない）申請の行ロックを取って読む。
  // 同時の承認・差し戻しを直列化し、監査ログのbefore/afterを正確にする。
  private async lockAssigned(
    tx: Prisma.TransactionClient,
    approverId: string,
    id: string,
  ): Promise<ExpenseRequest | null> {
    const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT "id" FROM "expense_requests"
      WHERE "id" = ${id}::uuid
        AND "approverId" = ${approverId}::uuid
        AND "applicantId" <> ${approverId}::uuid
      FOR UPDATE
    `);
    if (locked.length === 0) {
      return null;
    }
    return tx.expenseRequest.findFirst({
      where: { id, approverId, applicantId: { not: approverId } },
    });
  }

  private toDto(expense: ExpenseRequest): ExpenseRequestDto {
    return {
      id: expense.id,
      applicantId: expense.applicantId,
      approverId: expense.approverId,
      expenseDate: expense.expenseDate.toISOString().slice(0, 10),
      amount: expense.amount,
      category: expense.category as ExpenseRequestDto['category'],
      description: expense.description,
      status: expense.status as ExpenseStatus,
      returnReason: expense.returnReason,
      createdAt: expense.createdAt.toISOString(),
      updatedAt: expense.updatedAt.toISOString(),
    };
  }

  private notFound(): NotFoundException {
    return new NotFoundException({
      code: ErrorCode.NOT_FOUND,
      message: '対象の経費申請が見つかりません。',
    });
  }

  private conflictInvalidStatus(): ConflictException {
    return new ConflictException({
      code: ErrorCode.CONFLICT_INVALID_STATUS,
      message: '現在のステータスではこの操作はできません。',
    });
  }
}
