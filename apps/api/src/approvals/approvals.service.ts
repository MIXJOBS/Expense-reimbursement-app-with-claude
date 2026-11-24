import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ExpenseRequest } from '@prisma/client';
import {
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

@Injectable()
export class ApprovalsService {
  constructor(private readonly prisma: PrismaService) {}

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
   * 1. approverId・applicantId not self のみで存在確認 → 無ければ404。
   * 2. status条件つきupdateMany。0件なら409（同時実行の敗者を含む）。
   */
  async approve(approverId: string, id: string): Promise<ExpenseRequestDto> {
    await this.assertAssigned(approverId, id);

    const result = await this.prisma.expenseRequest.updateMany({
      where: {
        id,
        approverId,
        applicantId: { not: approverId },
        status: { in: EXPENSE_APPROVABLE_STATUSES },
      },
      data: { status: ExpenseStatus.APPROVED },
    });
    if (result.count === 0) {
      throw this.conflictInvalidStatus();
    }
    return this.reload(approverId, id);
  }

  /** 差し戻し。statusとreturnReasonは単一のUPDATEで同時に書く。 */
  async returnRequest(
    approverId: string,
    id: string,
    reason: string,
  ): Promise<ExpenseRequestDto> {
    await this.assertAssigned(approverId, id);

    const result = await this.prisma.expenseRequest.updateMany({
      where: {
        id,
        approverId,
        applicantId: { not: approverId },
        status: { in: EXPENSE_RETURNABLE_STATUSES },
      },
      data: { status: ExpenseStatus.RETURNED, returnReason: reason },
    });
    if (result.count === 0) {
      throw this.conflictInvalidStatus();
    }
    return this.reload(approverId, id);
  }

  private async assertAssigned(approverId: string, id: string): Promise<void> {
    const existing = await this.prisma.expenseRequest.findFirst({
      where: { id, approverId, applicantId: { not: approverId } },
      select: { id: true },
    });
    if (!existing) {
      throw this.notFound();
    }
  }

  // 更新後は status がSUBMITTEDでなくなっているため、findOneの絞り込みは使わない。
  private async reload(
    approverId: string,
    id: string,
  ): Promise<ExpenseRequestDto> {
    const updated = await this.prisma.expenseRequest.findFirst({
      where: { id, approverId, applicantId: { not: approverId } },
    });
    if (!updated) {
      throw this.notFound();
    }
    return this.toDto(updated);
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
