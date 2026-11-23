import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ExpenseRequest } from '@prisma/client';
import {
  ErrorCode,
  ExpenseStatus,
  EXPENSE_DELETABLE_STATUSES,
  EXPENSE_EDITABLE_STATUSES,
  EXPENSE_LIST_PAGE_SIZE,
  EXPENSE_SUBMITTABLE_STATUSES,
  type ExpenseRequestDto,
  type ExpenseRequestListResponseDto,
  type UpsertExpenseRequestBody,
} from '@expense/shared';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ExpensesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 下書き(DRAFT)の新規作成。status・applicantIdはサーバーが決める値
   * （ログイン中ユーザー・DRAFT固定）であり、リクエストボディからは受け取らない。
   */
  async create(
    applicantId: string,
    body: UpsertExpenseRequestBody,
  ): Promise<ExpenseRequestDto> {
    const expense = await this.prisma.expenseRequest.create({
      data: {
        applicantId,
        expenseDate: new Date(body.expenseDate),
        amount: body.amount,
        category: body.category,
        description: body.description,
        status: ExpenseStatus.DRAFT,
      },
    });
    return this.toDto(expense);
  }

  /**
   * 自分の申請一覧（ページネーション付き）。
   * Prismaのwhereに必ずapplicantId=自分の条件を含める（他人の申請を一切返さない）。
   */
  async list(
    applicantId: string,
    page: number,
  ): Promise<ExpenseRequestListResponseDto> {
    const where = { applicantId };

    const [items, total] = await Promise.all([
      this.prisma.expenseRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * EXPENSE_LIST_PAGE_SIZE,
        take: EXPENSE_LIST_PAGE_SIZE,
      }),
      this.prisma.expenseRequest.count({ where }),
    ]);

    return {
      items: items.map((item) => this.toDto(item)),
      total,
      page,
      pageSize: EXPENSE_LIST_PAGE_SIZE,
    };
  }

  /**
   * 自分の申請1件の詳細。他人の申請は404（applicantId条件で検索結果に現れない）。
   */
  async findOne(applicantId: string, id: string): Promise<ExpenseRequestDto> {
    const expense = await this.prisma.expenseRequest.findFirst({
      where: { id, applicantId },
    });
    if (!expense) {
      throw this.notFound();
    }
    return this.toDto(expense);
  }

  /**
   * 編集（PUT /expenses/:id）。許可ステータス: DRAFT, RETURNED。
   *
   * 2段階方式（docs/api/pbi-3.md・PO指示）：
   * 1. applicantIdのみの条件で存在確認 → 無ければ404（他人／存在しない）。
   * 2. status: { in: EXPENSE_EDITABLE_STATUSES } も条件に加えた条件付きupdateManyを実行。
   *    countが0件なら409 CONFLICT_INVALID_STATUS（並行して状態が変わった場合を含む）。
   */
  async update(
    applicantId: string,
    id: string,
    body: UpsertExpenseRequestBody,
  ): Promise<ExpenseRequestDto> {
    const existing = await this.prisma.expenseRequest.findFirst({
      where: { id, applicantId },
    });
    if (!existing) {
      throw this.notFound();
    }

    const result = await this.prisma.expenseRequest.updateMany({
      where: {
        id,
        applicantId,
        status: { in: EXPENSE_EDITABLE_STATUSES },
      },
      data: {
        expenseDate: new Date(body.expenseDate),
        amount: body.amount,
        category: body.category,
        description: body.description,
      },
    });

    if (result.count === 0) {
      throw this.conflictInvalidStatus();
    }

    const updated = await this.prisma.expenseRequest.findFirst({
      where: { id, applicantId },
    });
    if (!updated) {
      throw this.notFound();
    }
    return this.toDto(updated);
  }

  /**
   * 削除（DELETE /expenses/:id）。許可ステータス: DRAFTのみ。
   * 編集と同じ2段階方式。
   */
  async remove(applicantId: string, id: string): Promise<void> {
    const existing = await this.prisma.expenseRequest.findFirst({
      where: { id, applicantId },
    });
    if (!existing) {
      throw this.notFound();
    }

    const result = await this.prisma.expenseRequest.deleteMany({
      where: {
        id,
        applicantId,
        status: { in: EXPENSE_DELETABLE_STATUSES },
      },
    });

    if (result.count === 0) {
      throw this.conflictInvalidStatus();
    }
  }

  /**
   * 提出（POST /expenses/:id/submit）。許可ステータス: DRAFT, RETURNED。
   *
   * チェック順序（docs/api/pbi-3.md・PO指示）：
   * 1. applicantIdのみの条件で存在確認 → 無ければ404。
   * 2. ステータスがEXPENSE_SUBMITTABLE_STATUSESに含まれるか（存在確認結果で判定）
   *    → 含まれなければ409 CONFLICT_INVALID_STATUS。
   * 3. 2を通過したら、上長(User.managerId)が設定されているか確認
   *    → 未設定なら409 CONFLICT_MANAGER_NOT_SET。
   * 4. 条件付きupdateMany（status: { in: EXPENSE_SUBMITTABLE_STATUSES }も条件に含める）
   *    を実行し、countが0なら409 CONFLICT_INVALID_STATUS（TOCTOU対策、最終判定）。
   */
  async submit(applicantId: string, id: string): Promise<ExpenseRequestDto> {
    const existing = await this.prisma.expenseRequest.findFirst({
      where: { id, applicantId },
    });
    if (!existing) {
      throw this.notFound();
    }

    if (
      !EXPENSE_SUBMITTABLE_STATUSES.includes(existing.status as ExpenseStatus)
    ) {
      throw this.conflictInvalidStatus();
    }

    const applicant = await this.prisma.user.findUnique({
      where: { id: applicantId },
    });
    if (!applicant?.managerId) {
      throw this.conflictManagerNotSet();
    }

    const result = await this.prisma.expenseRequest.updateMany({
      where: {
        id,
        applicantId,
        status: { in: EXPENSE_SUBMITTABLE_STATUSES },
      },
      data: { status: ExpenseStatus.SUBMITTED },
    });

    if (result.count === 0) {
      throw this.conflictInvalidStatus();
    }

    const updated = await this.prisma.expenseRequest.findFirst({
      where: { id, applicantId },
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
      expenseDate: expense.expenseDate.toISOString().slice(0, 10),
      amount: expense.amount,
      category: expense.category as ExpenseRequestDto['category'],
      description: expense.description,
      status: expense.status as ExpenseStatus,
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

  private conflictManagerNotSet(): ConflictException {
    return new ConflictException({
      code: ErrorCode.CONFLICT_MANAGER_NOT_SET,
      message: '上長が設定されていないため提出できません。',
    });
  }
}
