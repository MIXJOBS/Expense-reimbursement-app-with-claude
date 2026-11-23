// PBI3（経費申請の登録・編集）の受け入れ条件に対応するe2eテスト。
//
// 前提：この時点では ExpensesModule / ExpensesController / ExpensesService 等は
// まだ実装されていない（docs/api/pbi-3.md 時点では設計のみ）。そのため、本ファイルの
// テストは「想定どおりに失敗する」（404 Not Found 等）ことを確認するためのものであり、
// 実装完了後に初めて意味のある合否判定ができるようになる。
//
// DBスキーマ（ExpenseRequest）は追加・マイグレーション適用済みのため、
// Controller/Serviceを経由せず、PrismaService経由で直接フィクスチャ（下書き・
// 他ステータスの申請）を作成できる（apps/api/test/support/fixtures.ts の
// createUser() がPrismaで直接Userを作っているのと同じパターン）。
//
// 実行方法：必ずテスト専用DB（expense_test）に対して実行すること。
// ルートから `pnpm test:e2e:api` を実行すると、.env.test のDATABASE_URLで
// テスト専用DBに向き、事前に pretest:e2e（migrate deploy + db seed）が走る。
//
// 担当範囲: *.spec.ts / e2e のみ。実装コード（Controller/Service/Guard/main.ts等）は書かない。
import './support/env';
import * as crypto from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  ErrorCode,
  ExpenseCategory,
  ExpenseStatus,
  EXPENSE_AMOUNT_MAX,
  EXPENSE_AMOUNT_MIN,
  EXPENSE_DESCRIPTION_MAX_LENGTH,
  EXPENSE_LIST_PAGE_SIZE,
} from '@expense/shared';
import {
  ALLOWED_ORIGIN,
  DISALLOWED_ORIGIN,
  createSessionCookie,
  createUser,
  uniqueEmail,
} from './support/fixtures';

// 有効な経費申請ボディの最小セット（他のテストで部分的に上書きして使う）。
function validBody(overrides: Record<string, unknown> = {}) {
  return {
    expenseDate: '2026-11-20',
    amount: 1500,
    category: ExpenseCategory.TRANSPORTATION,
    description: '取引先訪問の電車代',
    ...overrides,
  };
}

describe('Expenses (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  // 各テストが作成したUser/ExpenseRequestのIDをここに積み、afterEachで必ず削除する。
  // assert失敗時でもafterEachは実行されるため、後始末漏れでDBにゴミが残ることを防ぐ。
  let createdUserIds: string[] = [];
  let createdExpenseIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
  });

  afterEach(async () => {
    if (createdExpenseIds.length > 0) {
      await prisma.expenseRequest.deleteMany({
        where: { id: { in: createdExpenseIds } },
      });
      createdExpenseIds = [];
    }
    if (createdUserIds.length > 0) {
      await prisma.session.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.userRole.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      createdUserIds = [];
    }
  });

  afterAll(async () => {
    await app.close();
  });

  // ログイン済みユーザー（上長未設定）を作成するヘルパー。
  async function createLoggedInUser(prefix: string) {
    const email = uniqueEmail(prefix);
    const user = await createUser(prisma, { email });
    createdUserIds.push(user.id);
    const { cookieHeader } = await createSessionCookie(prisma, user.id);
    return { userId: user.id, cookieHeader };
  }

  // ログイン済みユーザー（上長設定済み）を作成するヘルパー。
  async function createLoggedInUserWithManager(prefix: string) {
    const managerEmail = uniqueEmail(`${prefix}-manager`);
    const manager = await createUser(prisma, { email: managerEmail });
    createdUserIds.push(manager.id);

    const email = uniqueEmail(prefix);
    const user = await createUser(prisma, {
      email,
      managerId: manager.id,
    });
    createdUserIds.push(user.id);
    const { cookieHeader } = await createSessionCookie(prisma, user.id);
    return { userId: user.id, cookieHeader };
  }

  // Prismaで直接ExpenseRequestを作成するヘルパー。
  async function createExpense(params: {
    applicantId: string;
    status?: ExpenseStatus;
    expenseDate?: Date;
    amount?: number;
    category?: ExpenseCategory;
    description?: string;
  }) {
    const expense = await prisma.expenseRequest.create({
      data: {
        applicantId: params.applicantId,
        expenseDate: params.expenseDate ?? new Date('2026-11-20'),
        amount: params.amount ?? 1500,
        category: params.category ?? ExpenseCategory.TRANSPORTATION,
        description: params.description ?? '経費テスト用データ',
        status: params.status ?? ExpenseStatus.DRAFT,
      },
    });
    createdExpenseIds.push(expense.id);
    return expense;
  }

  // ============================================================
  // POST /expenses - 下書きの作成
  // ============================================================
  describe('POST /expenses - 下書きの作成', () => {
    it('正常系：利用日・金額・科目・内容を送ると201で作成され、ステータスはDRAFT固定になる', async () => {
      const { userId, cookieHeader } = await createLoggedInUser('create-ok');

      const res = await request(app.getHttpServer())
        .post('/expenses')
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', cookieHeader)
        .send(validBody());

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        applicantId: userId,
        amount: 1500,
        category: ExpenseCategory.TRANSPORTATION,
        description: '取引先訪問の電車代',
        status: ExpenseStatus.DRAFT,
      });
      if (res.body?.id) {
        createdExpenseIds.push(res.body.id);
      }

      // DBにもDRAFTで作成されていることを直接確認する。
      const row = await prisma.expenseRequest.findUnique({
        where: { id: res.body.id },
      });
      expect(row?.status).toBe(ExpenseStatus.DRAFT);
      expect(row?.applicantId).toBe(userId);
    });

    describe('異常系：金額の検証', () => {
      it.each([
        ['0以下（0）', 0],
        ['0以下（負数）', -100],
        ['小数', 100.5],
        ['上限超え', EXPENSE_AMOUNT_MAX + 1],
      ])('400 VALIDATION_ERROR: 金額が不正（%s）', async (_label, amount) => {
        const { cookieHeader } = await createLoggedInUser('amount-invalid');

        const res = await request(app.getHttpServer())
          .post('/expenses')
          .set('Origin', ALLOWED_ORIGIN)
          .set('Cookie', cookieHeader)
          .send(validBody({ amount }));

        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
      });

      it.each([
        ['下限（1円）', EXPENSE_AMOUNT_MIN],
        ['上限（1,000,000円）', EXPENSE_AMOUNT_MAX],
      ])('正常系：金額の境界値（%s）は通る', async (_label, amount) => {
        const { cookieHeader } = await createLoggedInUser('amount-boundary');

        const res = await request(app.getHttpServer())
          .post('/expenses')
          .set('Origin', ALLOWED_ORIGIN)
          .set('Cookie', cookieHeader)
          .send(validBody({ amount }));

        expect(res.status).toBe(201);
        expect(res.body?.amount).toBe(amount);
        if (res.body?.id) {
          createdExpenseIds.push(res.body.id);
        }
      });
    });

    describe('異常系：科目の検証', () => {
      it('400 VALIDATION_ERROR: ALL_EXPENSE_CATEGORIESに無い値（"FOO"）', async () => {
        const { cookieHeader } = await createLoggedInUser('category-invalid');

        const res = await request(app.getHttpServer())
          .post('/expenses')
          .set('Origin', ALLOWED_ORIGIN)
          .set('Cookie', cookieHeader)
          .send(validBody({ category: 'FOO' }));

        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
      });
    });

    describe('異常系：内容の検証', () => {
      it('400 VALIDATION_ERROR: 内容が201文字以上', async () => {
        const { cookieHeader } = await createLoggedInUser('description-too-long');

        const res = await request(app.getHttpServer())
          .post('/expenses')
          .set('Origin', ALLOWED_ORIGIN)
          .set('Cookie', cookieHeader)
          .send(validBody({ description: 'a'.repeat(EXPENSE_DESCRIPTION_MAX_LENGTH + 1) }));

        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
      });

      it('正常系：内容が200文字（境界値）は通る', async () => {
        const { cookieHeader } = await createLoggedInUser('description-boundary');
        const description = 'a'.repeat(EXPENSE_DESCRIPTION_MAX_LENGTH);

        const res = await request(app.getHttpServer())
          .post('/expenses')
          .set('Origin', ALLOWED_ORIGIN)
          .set('Cookie', cookieHeader)
          .send(validBody({ description }));

        expect(res.status).toBe(201);
        expect(res.body?.description).toBe(description);
        if (res.body?.id) {
          createdExpenseIds.push(res.body.id);
        }
      });
    });

    describe('異常系：想定外のプロパティ（status・applicantId）', () => {
      it('400 VALIDATION_ERROR: statusを送ると拒否される（forbidNonWhitelisted）', async () => {
        const { cookieHeader } = await createLoggedInUser('create-extra-status');

        const res = await request(app.getHttpServer())
          .post('/expenses')
          .set('Origin', ALLOWED_ORIGIN)
          .set('Cookie', cookieHeader)
          .send(validBody({ status: ExpenseStatus.APPROVED }));

        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
      });

      it('400 VALIDATION_ERROR: applicantIdを送ると拒否される（forbidNonWhitelisted）', async () => {
        const { cookieHeader } = await createLoggedInUser('create-extra-applicant');

        const res = await request(app.getHttpServer())
          .post('/expenses')
          .set('Origin', ALLOWED_ORIGIN)
          .set('Cookie', cookieHeader)
          .send(validBody({ applicantId: crypto.randomUUID() }));

        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
      });
    });

    describe('権限系', () => {
      it('401 AUTH_UNAUTHORIZED: 未ログイン（Cookie無し）', async () => {
        const res = await request(app.getHttpServer())
          .post('/expenses')
          .set('Origin', ALLOWED_ORIGIN)
          .send(validBody());

        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ code: ErrorCode.AUTH_UNAUTHORIZED });
      });
    });

    describe('CSRF対策', () => {
      it('403 FORBIDDEN: 許可されていないOriginからのPOST', async () => {
        const { cookieHeader } = await createLoggedInUser('create-csrf');

        const res = await request(app.getHttpServer())
          .post('/expenses')
          .set('Origin', DISALLOWED_ORIGIN)
          .set('Cookie', cookieHeader)
          .send(validBody());

        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: ErrorCode.FORBIDDEN });
      });
    });
  });

  // ============================================================
  // GET /expenses - 一覧（自分の申請だけ・ページネーション）
  // ============================================================
  describe('GET /expenses - 一覧', () => {
    it('正常系：自分の申請だけが返り、他ユーザーの申請は混ざらない', async () => {
      const { userId, cookieHeader } = await createLoggedInUser('list-self');
      const other = await createLoggedInUser('list-other');

      await createExpense({ applicantId: userId });
      await createExpense({ applicantId: userId });
      await createExpense({ applicantId: other.userId });
      await createExpense({ applicantId: other.userId });

      const res = await request(app.getHttpServer())
        .get('/expenses')
        .set('Cookie', cookieHeader);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(res.body.items).toHaveLength(2);
      for (const item of res.body.items) {
        expect(item.applicantId).toBe(userId);
      }
    });

    it('正常系：1ページ20件（EXPENSE_LIST_PAGE_SIZE）で、page=1とpage=2で分割される', async () => {
      const { userId, cookieHeader } = await createLoggedInUser('list-pagination');

      const totalCount = EXPENSE_LIST_PAGE_SIZE + 3;
      for (let i = 0; i < totalCount; i++) {
        await createExpense({ applicantId: userId });
      }

      const page1 = await request(app.getHttpServer())
        .get('/expenses')
        .query({ page: 1 })
        .set('Cookie', cookieHeader);

      expect(page1.status).toBe(200);
      expect(page1.body.total).toBe(totalCount);
      expect(page1.body.pageSize).toBe(EXPENSE_LIST_PAGE_SIZE);
      expect(page1.body.items).toHaveLength(EXPENSE_LIST_PAGE_SIZE);

      const page2 = await request(app.getHttpServer())
        .get('/expenses')
        .query({ page: 2 })
        .set('Cookie', cookieHeader);

      expect(page2.status).toBe(200);
      expect(page2.body.items).toHaveLength(totalCount - EXPENSE_LIST_PAGE_SIZE);
    });

    describe('異常系：pageクエリの検証', () => {
      it.each([['0', '0'], ['-1', '-1'], ['abc（数値でない）', 'abc']])(
        '400 VALIDATION_ERROR: page=%s',
        async (_label, page) => {
          const { cookieHeader } = await createLoggedInUser('list-page-invalid');

          const res = await request(app.getHttpServer())
            .get('/expenses')
            .query({ page })
            .set('Cookie', cookieHeader);

          expect(res.status).toBe(400);
          expect(res.body).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
        },
      );
    });

    describe('権限系', () => {
      it('401 AUTH_UNAUTHORIZED: 未ログイン（Cookie無し）', async () => {
        const res = await request(app.getHttpServer()).get('/expenses');

        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ code: ErrorCode.AUTH_UNAUTHORIZED });
      });
    });
  });

  // ============================================================
  // GET /expenses/:id - 詳細
  // ============================================================
  describe('GET /expenses/:id - 詳細', () => {
    it('正常系：自分のDRAFT申請を取得できる', async () => {
      const { userId, cookieHeader } = await createLoggedInUser('get-own');
      const expense = await createExpense({ applicantId: userId });

      const res = await request(app.getHttpServer())
        .get(`/expenses/${expense.id}`)
        .set('Cookie', cookieHeader);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: expense.id,
        applicantId: userId,
      });
    });

    describe('権限系', () => {
      it('404 NOT_FOUND: 他人の申請を取得しようとすると404', async () => {
        const { cookieHeader } = await createLoggedInUser('get-other-actor');
        const owner = await createLoggedInUser('get-other-owner');
        const expense = await createExpense({ applicantId: owner.userId });

        // 前提確認：申請者本人が同じIDを取得すると200になる
        // （＝対象のリソースは実在し、以降の404が「他人だから」であることを保証する）。
        const ownerRes = await request(app.getHttpServer())
          .get(`/expenses/${expense.id}`)
          .set('Cookie', owner.cookieHeader);
        expect(ownerRes.status).toBe(200);

        const res = await request(app.getHttpServer())
          .get(`/expenses/${expense.id}`)
          .set('Cookie', cookieHeader);

        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({ code: ErrorCode.NOT_FOUND });
      });

      it('401 AUTH_UNAUTHORIZED: 未ログイン（Cookie無し）', async () => {
        const owner = await createLoggedInUser('get-unauth-owner');
        const expense = await createExpense({ applicantId: owner.userId });

        const res = await request(app.getHttpServer()).get(
          `/expenses/${expense.id}`,
        );

        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ code: ErrorCode.AUTH_UNAUTHORIZED });
      });
    });
  });

  // ============================================================
  // PUT /expenses/:id - 編集
  // ============================================================
  describe('PUT /expenses/:id - 編集', () => {
    it('正常系：自分のDRAFT申請を編集できる', async () => {
      const { userId, cookieHeader } = await createLoggedInUser('edit-ok');
      const expense = await createExpense({ applicantId: userId });

      const res = await request(app.getHttpServer())
        .put(`/expenses/${expense.id}`)
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', cookieHeader)
        .send(validBody({ amount: 2000, description: '編集後の内容' }));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: expense.id,
        amount: 2000,
        description: '編集後の内容',
      });

      const row = await prisma.expenseRequest.findUnique({
        where: { id: expense.id },
      });
      expect(row?.amount).toBe(2000);
    });

    describe('異常系：想定外のプロパティ（status・applicantId）', () => {
      it('400 VALIDATION_ERROR: statusを送ると拒否される', async () => {
        const { userId, cookieHeader } = await createLoggedInUser('edit-extra-status');
        const expense = await createExpense({ applicantId: userId });

        const res = await request(app.getHttpServer())
          .put(`/expenses/${expense.id}`)
          .set('Origin', ALLOWED_ORIGIN)
          .set('Cookie', cookieHeader)
          .send(validBody({ status: ExpenseStatus.SUBMITTED }));

        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
      });

      it('400 VALIDATION_ERROR: applicantIdを送ると拒否される', async () => {
        const { userId, cookieHeader } = await createLoggedInUser('edit-extra-applicant');
        const expense = await createExpense({ applicantId: userId });

        const res = await request(app.getHttpServer())
          .put(`/expenses/${expense.id}`)
          .set('Origin', ALLOWED_ORIGIN)
          .set('Cookie', cookieHeader)
          .send(validBody({ applicantId: crypto.randomUUID() }));

        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
      });
    });

    describe('権限系', () => {
      it('404 NOT_FOUND: 他人のDRAFT申請を編集しようとすると404', async () => {
        const { cookieHeader } = await createLoggedInUser('edit-other-actor');
        const owner = await createLoggedInUser('edit-other-owner');
        const expense = await createExpense({ applicantId: owner.userId });

        // 前提確認：申請者本人が同じIDをGET（読み取り専用）すると200になる。
        // PUT/DELETE/submitを本人に先に呼ぶと対象の状態が変わってしまうため、
        // 確認はGETに限定する。
        const ownerRes = await request(app.getHttpServer())
          .get(`/expenses/${expense.id}`)
          .set('Cookie', owner.cookieHeader);
        expect(ownerRes.status).toBe(200);

        const res = await request(app.getHttpServer())
          .put(`/expenses/${expense.id}`)
          .set('Origin', ALLOWED_ORIGIN)
          .set('Cookie', cookieHeader)
          .send(validBody());

        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({ code: ErrorCode.NOT_FOUND });
      });

      it('401 AUTH_UNAUTHORIZED: 未ログイン（Cookie無し）', async () => {
        const owner = await createLoggedInUser('edit-unauth-owner');
        const expense = await createExpense({ applicantId: owner.userId });

        const res = await request(app.getHttpServer())
          .put(`/expenses/${expense.id}`)
          .set('Origin', ALLOWED_ORIGIN)
          .send(validBody());

        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ code: ErrorCode.AUTH_UNAUTHORIZED });
      });
    });

    describe('CSRF対策', () => {
      it('403 FORBIDDEN: 許可されていないOriginからのPUT', async () => {
        const { userId, cookieHeader } = await createLoggedInUser('edit-csrf');
        const expense = await createExpense({ applicantId: userId });

        const res = await request(app.getHttpServer())
          .put(`/expenses/${expense.id}`)
          .set('Origin', DISALLOWED_ORIGIN)
          .set('Cookie', cookieHeader)
          .send(validBody());

        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: ErrorCode.FORBIDDEN });
      });
    });

    describe('状態系：編集不可ステータスは409 CONFLICT_INVALID_STATUS', () => {
      it.each([
        [ExpenseStatus.SUBMITTED],
        [ExpenseStatus.APPROVED],
        [ExpenseStatus.ACCOUNTING_CONFIRMED],
      ])('409 CONFLICT_INVALID_STATUS: ステータスが%sの申請を編集しようとする', async (status) => {
        const { userId, cookieHeader } = await createLoggedInUser(
          `edit-invalid-status-${status.toLowerCase()}`,
        );
        const expense = await createExpense({ applicantId: userId, status });

        const res = await request(app.getHttpServer())
          .put(`/expenses/${expense.id}`)
          .set('Origin', ALLOWED_ORIGIN)
          .set('Cookie', cookieHeader)
          .send(validBody());

        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          code: ErrorCode.CONFLICT_INVALID_STATUS,
        });
      });
    });
  });

  // ============================================================
  // DELETE /expenses/:id - 削除
  // ============================================================
  describe('DELETE /expenses/:id - 削除', () => {
    it('正常系：自分のDRAFT申請を削除できる', async () => {
      const { userId, cookieHeader } = await createLoggedInUser('delete-ok');
      const expense = await createExpense({ applicantId: userId });

      const res = await request(app.getHttpServer())
        .delete(`/expenses/${expense.id}`)
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', cookieHeader);

      expect(res.status).toBe(204);

      const row = await prisma.expenseRequest.findUnique({
        where: { id: expense.id },
      });
      expect(row).toBeNull();
      // 既に削除されているため、afterEachでの重複削除対象から外す。
      createdExpenseIds = createdExpenseIds.filter((id) => id !== expense.id);
    });

    describe('権限系', () => {
      it('404 NOT_FOUND: 他人のDRAFT申請を削除しようとすると404', async () => {
        const { cookieHeader } = await createLoggedInUser('delete-other-actor');
        const owner = await createLoggedInUser('delete-other-owner');
        const expense = await createExpense({ applicantId: owner.userId });

        // 前提確認：申請者本人が同じIDをGET（読み取り専用）すると200になる。
        // 本人によるDELETEを事前に呼ぶとリソースが消えてしまい、後続の
        // 「他人によるDELETE→404」の検証対象が無くなってしまうため、GETに限定する。
        const ownerRes = await request(app.getHttpServer())
          .get(`/expenses/${expense.id}`)
          .set('Cookie', owner.cookieHeader);
        expect(ownerRes.status).toBe(200);

        const res = await request(app.getHttpServer())
          .delete(`/expenses/${expense.id}`)
          .set('Origin', ALLOWED_ORIGIN)
          .set('Cookie', cookieHeader);

        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({ code: ErrorCode.NOT_FOUND });

        // 削除されていないはずであることも確認する。
        const row = await prisma.expenseRequest.findUnique({
          where: { id: expense.id },
        });
        expect(row).not.toBeNull();
      });

      it('401 AUTH_UNAUTHORIZED: 未ログイン（Cookie無し）', async () => {
        const owner = await createLoggedInUser('delete-unauth-owner');
        const expense = await createExpense({ applicantId: owner.userId });

        const res = await request(app.getHttpServer())
          .delete(`/expenses/${expense.id}`)
          .set('Origin', ALLOWED_ORIGIN);

        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ code: ErrorCode.AUTH_UNAUTHORIZED });
      });
    });

    describe('CSRF対策', () => {
      it('403 FORBIDDEN: 許可されていないOriginからのDELETE', async () => {
        const { userId, cookieHeader } = await createLoggedInUser('delete-csrf');
        const expense = await createExpense({ applicantId: userId });

        const res = await request(app.getHttpServer())
          .delete(`/expenses/${expense.id}`)
          .set('Origin', DISALLOWED_ORIGIN)
          .set('Cookie', cookieHeader);

        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: ErrorCode.FORBIDDEN });
      });
    });

    describe('状態系：削除不可ステータスは409 CONFLICT_INVALID_STATUS', () => {
      it.each([
        [ExpenseStatus.SUBMITTED],
        [ExpenseStatus.APPROVED],
        [ExpenseStatus.ACCOUNTING_CONFIRMED],
      ])('409 CONFLICT_INVALID_STATUS: ステータスが%sの申請を削除しようとする', async (status) => {
        const { userId, cookieHeader } = await createLoggedInUser(
          `delete-invalid-status-${status.toLowerCase()}`,
        );
        const expense = await createExpense({ applicantId: userId, status });

        const res = await request(app.getHttpServer())
          .delete(`/expenses/${expense.id}`)
          .set('Origin', ALLOWED_ORIGIN)
          .set('Cookie', cookieHeader);

        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          code: ErrorCode.CONFLICT_INVALID_STATUS,
        });
      });

      it('409 CONFLICT_INVALID_STATUS: 差し戻し(RETURNED)中の申請を削除しようとする（編集は許可だが削除は禁止）', async () => {
        const { userId, cookieHeader } = await createLoggedInUser('delete-returned');
        const expense = await createExpense({
          applicantId: userId,
          status: ExpenseStatus.RETURNED,
        });

        const res = await request(app.getHttpServer())
          .delete(`/expenses/${expense.id}`)
          .set('Origin', ALLOWED_ORIGIN)
          .set('Cookie', cookieHeader);

        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          code: ErrorCode.CONFLICT_INVALID_STATUS,
        });
      });
    });
  });

  // ============================================================
  // POST /expenses/:id/submit - 提出
  // ============================================================
  describe('POST /expenses/:id/submit - 提出', () => {
    it('正常系：上長が設定されている申請者が、自分のDRAFT申請を提出すると200でSUBMITTEDになる', async () => {
      const { userId, cookieHeader } = await createLoggedInUserWithManager(
        'submit-ok',
      );
      const expense = await createExpense({ applicantId: userId });

      const res = await request(app.getHttpServer())
        .post(`/expenses/${expense.id}/submit`)
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', cookieHeader);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: expense.id,
        status: ExpenseStatus.SUBMITTED,
      });

      const row = await prisma.expenseRequest.findUnique({
        where: { id: expense.id },
      });
      expect(row?.status).toBe(ExpenseStatus.SUBMITTED);
    });

    it('正常系：差し戻し(RETURNED)の申請を再提出すると200でSUBMITTEDになる（上長設定済み）', async () => {
      const { userId, cookieHeader } = await createLoggedInUserWithManager(
        'submit-returned',
      );
      const expense = await createExpense({
        applicantId: userId,
        status: ExpenseStatus.RETURNED,
      });

      const res = await request(app.getHttpServer())
        .post(`/expenses/${expense.id}/submit`)
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', cookieHeader);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: expense.id,
        status: ExpenseStatus.SUBMITTED,
      });
    });

    it('409 CONFLICT_MANAGER_NOT_SET: 上長未設定のユーザーが提出しようとすると409', async () => {
      const { userId, cookieHeader } = await createLoggedInUser(
        'submit-no-manager',
      );
      const expense = await createExpense({ applicantId: userId });

      const res = await request(app.getHttpServer())
        .post(`/expenses/${expense.id}/submit`)
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', cookieHeader);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: ErrorCode.CONFLICT_MANAGER_NOT_SET,
      });
    });

    describe('状態系：提出不可ステータスは409 CONFLICT_INVALID_STATUS', () => {
      it.each([
        [ExpenseStatus.SUBMITTED],
        [ExpenseStatus.APPROVED],
        [ExpenseStatus.ACCOUNTING_CONFIRMED],
      ])('409 CONFLICT_INVALID_STATUS: ステータスが%sの申請を提出しようとする（二重提出含む）', async (status) => {
        const { userId, cookieHeader } = await createLoggedInUserWithManager(
          `submit-invalid-status-${status.toLowerCase()}`,
        );
        const expense = await createExpense({ applicantId: userId, status });

        const res = await request(app.getHttpServer())
          .post(`/expenses/${expense.id}/submit`)
          .set('Origin', ALLOWED_ORIGIN)
          .set('Cookie', cookieHeader);

        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          code: ErrorCode.CONFLICT_INVALID_STATUS,
        });
      });
    });

    describe('権限系', () => {
      it('404 NOT_FOUND: 他人のDRAFT申請を提出しようとすると404', async () => {
        const { cookieHeader } = await createLoggedInUser('submit-other-actor');
        const owner = await createLoggedInUserWithManager('submit-other-owner');
        const expense = await createExpense({ applicantId: owner.userId });

        // 前提確認：申請者本人が同じIDをGET（読み取り専用）すると200になる。
        // 本人によるsubmitを事前に呼ぶとステータスがSUBMITTEDに変わってしまい、
        // 後続の「他人によるsubmit→404」の検証対象が変わってしまうため、GETに限定する。
        const ownerRes = await request(app.getHttpServer())
          .get(`/expenses/${expense.id}`)
          .set('Cookie', owner.cookieHeader);
        expect(ownerRes.status).toBe(200);

        const res = await request(app.getHttpServer())
          .post(`/expenses/${expense.id}/submit`)
          .set('Origin', ALLOWED_ORIGIN)
          .set('Cookie', cookieHeader);

        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({ code: ErrorCode.NOT_FOUND });

        // ステータスが変わっていないことも確認する。
        const row = await prisma.expenseRequest.findUnique({
          where: { id: expense.id },
        });
        expect(row?.status).toBe(ExpenseStatus.DRAFT);
      });

      it('401 AUTH_UNAUTHORIZED: 未ログイン（Cookie無し）', async () => {
        const owner = await createLoggedInUserWithManager('submit-unauth-owner');
        const expense = await createExpense({ applicantId: owner.userId });

        const res = await request(app.getHttpServer())
          .post(`/expenses/${expense.id}/submit`)
          .set('Origin', ALLOWED_ORIGIN);

        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ code: ErrorCode.AUTH_UNAUTHORIZED });
      });
    });

    describe('CSRF対策', () => {
      it('403 FORBIDDEN: 許可されていないOriginからのPOST submit', async () => {
        const { userId, cookieHeader } = await createLoggedInUserWithManager(
          'submit-csrf',
        );
        const expense = await createExpense({ applicantId: userId });

        const res = await request(app.getHttpServer())
          .post(`/expenses/${expense.id}/submit`)
          .set('Origin', DISALLOWED_ORIGIN)
          .set('Cookie', cookieHeader);

        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: ErrorCode.FORBIDDEN });
      });
    });
  });
});
