// PBI4（承認・差し戻し）の受け入れ条件に対応するe2eテスト。
// 仕様：docs/requirements/sprint-2.md の PBI 4 / docs/api/pbi-4.md
//
// 前提：この時点では ApprovalsModule 等は未実装のため、新規テストは
// 「実装がないため失敗する」（404 等）ことが想定どおり。
// 実装後に初めて合否判定が意味を持つ。
//
// 方針：
// - フィクスチャ（申請・承認者）はPrismaで直接作成する（expenses.e2e-spec.ts と同じ）。
// - 「担当外は404」「他人は404」系は、先に本来の承認者で成功（200）することを
//   確認してから、同じIDで担当外ユーザーを検証する（偶然404で通ることを防ぐ）。
//
// 担当範囲: *.spec.ts / e2e のみ。実装コードは触らない。
import './support/env';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  ErrorCode,
  ExpenseCategory,
  ExpenseStatus,
  EXPENSE_RETURN_REASON_MAX_LENGTH,
  RoleName,
} from '@expense/shared';
import {
  ALLOWED_ORIGIN,
  DISALLOWED_ORIGIN,
  createSessionCookie,
  createUser,
  getRoleByName,
  grantRole,
  uniqueEmail,
} from './support/fixtures';

const NON_EXISTENT_ID = '00000000-0000-4000-8000-000000000000';

describe('Approvals (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

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

  // ---------- ヘルパー ----------

  async function createLoggedInUser(
    prefix: string,
    opts: { managerId?: string | null; roles?: RoleName[] } = {},
  ) {
    const user = await createUser(prisma, {
      email: uniqueEmail(prefix),
      managerId: opts.managerId ?? null,
    });
    createdUserIds.push(user.id);
    for (const roleName of opts.roles ?? []) {
      const role = await getRoleByName(prisma, roleName);
      await grantRole(prisma, user.id, role.id);
    }
    const { cookieHeader } = await createSessionCookie(prisma, user.id);
    return { userId: user.id, cookieHeader };
  }

  // MANAGERロール付きユーザー
  function createManager(prefix: string) {
    return createLoggedInUser(prefix, {
      roles: [RoleName.APPLICANT, RoleName.MANAGER],
    });
  }

  // 上長を持つ申請者（APPLICANTロール）
  function createApplicant(prefix: string, managerId: string | null) {
    return createLoggedInUser(prefix, {
      managerId,
      roles: [RoleName.APPLICANT],
    });
  }

  async function createExpense(params: {
    applicantId: string;
    approverId?: string | null;
    status?: ExpenseStatus;
  }) {
    const expense = await prisma.expenseRequest.create({
      data: {
        applicantId: params.applicantId,
        approverId: params.approverId ?? null,
        expenseDate: new Date('2026-11-20'),
        amount: 1500,
        category: ExpenseCategory.TRANSPORTATION,
        description: '承認テスト用データ',
        status: params.status ?? ExpenseStatus.SUBMITTED,
      },
    });
    createdExpenseIds.push(expense.id);
    return expense;
  }

  // manager配下の申請者とSUBMITTED申請をまとめて作る
  async function setupSubmitted(prefix: string) {
    const manager = await createManager(`${prefix}-mgr`);
    const applicant = await createApplicant(`${prefix}-app`, manager.userId);
    const expense = await createExpense({
      applicantId: applicant.userId,
      approverId: manager.userId,
    });
    return { manager, applicant, expense };
  }

  const approve = (id: string, cookie: string, origin = ALLOWED_ORIGIN) =>
    request(app.getHttpServer())
      .post(`/approvals/${id}/approve`)
      .set('Origin', origin)
      .set('Cookie', cookie);

  const returnIt = (
    id: string,
    cookie: string,
    body: Record<string, unknown> = { reason: '領収書を添付してください' },
    origin = ALLOWED_ORIGIN,
  ) =>
    request(app.getHttpServer())
      .post(`/approvals/${id}/return`)
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send(body);

  const getOne = (id: string, cookie: string) =>
    request(app.getHttpServer()).get(`/approvals/${id}`).set('Cookie', cookie);

  // ============================================================
  // GET /approvals - 一覧
  // ============================================================
  describe('GET /approvals - 一覧', () => {
    it('正常系：自分が承認者でSUBMITTEDの申請だけが出る（他の承認者宛・他ステータス・自分自身の申請は出ない）', async () => {
      const manager = await createManager('list-mgr');
      const otherManager = await createManager('list-other-mgr');
      const applicant = await createApplicant('list-app', manager.userId);

      const mine = await createExpense({
        applicantId: applicant.userId,
        approverId: manager.userId,
      });
      // 出てはいけないもの
      const otherApprover = await createExpense({
        applicantId: applicant.userId,
        approverId: otherManager.userId,
      });
      const approved = await createExpense({
        applicantId: applicant.userId,
        approverId: manager.userId,
        status: ExpenseStatus.APPROVED,
      });
      const returned = await createExpense({
        applicantId: applicant.userId,
        approverId: manager.userId,
        status: ExpenseStatus.RETURNED,
      });
      const draft = await createExpense({
        applicantId: applicant.userId,
        approverId: manager.userId,
        status: ExpenseStatus.DRAFT,
      });
      // 自分自身が申請者かつ承認者になっている異常データ
      const selfApplied = await createExpense({
        applicantId: manager.userId,
        approverId: manager.userId,
      });

      const res = await request(app.getHttpServer())
        .get('/approvals')
        .set('Cookie', manager.cookieHeader);

      expect(res.status).toBe(200);
      const ids = (res.body.items as { id: string }[]).map((i) => i.id);
      expect(ids).toContain(mine.id);
      for (const e of [otherApprover, approved, returned, draft, selfApplied]) {
        expect(ids).not.toContain(e.id);
      }
      for (const item of res.body.items) {
        expect(item.status).toBe(ExpenseStatus.SUBMITTED);
        expect(item.approverId).toBe(manager.userId);
      }
    });

    it('正常系：該当する申請がなければ空配列', async () => {
      const manager = await createManager('list-empty');
      const res = await request(app.getHttpServer())
        .get('/approvals')
        .set('Cookie', manager.cookieHeader);
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
    });

    it('403 FORBIDDEN: MANAGERロールがないと一覧は見られない', async () => {
      const applicant = await createApplicant('list-norole', null);
      const res = await request(app.getHttpServer())
        .get('/approvals')
        .set('Cookie', applicant.cookieHeader);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: ErrorCode.FORBIDDEN });
    });

    it('401 AUTH_UNAUTHORIZED: 未ログイン', async () => {
      const res = await request(app.getHttpServer()).get('/approvals');
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: ErrorCode.AUTH_UNAUTHORIZED });
    });
  });

  // ============================================================
  // GET /approvals/:id - 詳細
  // ============================================================
  describe('GET /approvals/:id - 詳細', () => {
    it('正常系：担当の承認者は200。そのうえで同じIDを担当外の承認者が見ると404', async () => {
      const { manager, expense } = await setupSubmitted('get');
      const stranger = await createManager('get-stranger');

      const ok = await getOne(expense.id, manager.cookieHeader);
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({
        id: expense.id,
        status: ExpenseStatus.SUBMITTED,
      });

      const res = await getOne(expense.id, stranger.cookieHeader);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('404 NOT_FOUND: 存在しないID', async () => {
      // 先に、同じ承認者が実在する担当申請なら200で見られる（ルート自体は存在する）ことを確認
      const { manager, expense } = await setupSubmitted('get-nonexistent');
      const ok = await getOne(expense.id, manager.cookieHeader);
      expect(ok.status).toBe(200);

      const res = await getOne(NON_EXISTENT_ID, manager.cookieHeader);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('404 NOT_FOUND: 担当でもSUBMITTED以外は見えない', async () => {
      const { manager, applicant } = await setupSubmitted('get-status');
      const approved = await createExpense({
        applicantId: applicant.userId,
        approverId: manager.userId,
        status: ExpenseStatus.APPROVED,
      });
      const res = await getOne(approved.id, manager.cookieHeader);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('403 FORBIDDEN: MANAGERロールなし', async () => {
      const { expense } = await setupSubmitted('get-norole');
      const applicant = await createApplicant('get-norole-user', null);
      const res = await getOne(expense.id, applicant.cookieHeader);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: ErrorCode.FORBIDDEN });
    });

    it('401 AUTH_UNAUTHORIZED: 未ログイン', async () => {
      const { expense } = await setupSubmitted('get-unauth');
      const res = await request(app.getHttpServer()).get(
        `/approvals/${expense.id}`,
      );
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: ErrorCode.AUTH_UNAUTHORIZED });
    });
  });

  // ============================================================
  // POST /approvals/:id/approve - 承認
  // ============================================================
  describe('POST /approvals/:id/approve - 承認', () => {
    it('正常系：担当の承認者が承認すると200でAPPROVEDになる', async () => {
      const { manager, expense } = await setupSubmitted('approve-ok');

      const res = await approve(expense.id, manager.cookieHeader);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: expense.id,
        status: ExpenseStatus.APPROVED,
      });
      const row = await prisma.expenseRequest.findUnique({
        where: { id: expense.id },
      });
      expect(row?.status).toBe(ExpenseStatus.APPROVED);
    });

    it('404 NOT_FOUND: 担当外の承認者は承認できない（先に本来の承認者で同じIDが200になることを確認）', async () => {
      const { manager, expense } = await setupSubmitted('approve-stranger');
      const stranger = await createManager('approve-stranger-other');

      // 1) 本来の承認者なら同じIDで成功する
      const ok = await approve(expense.id, manager.cookieHeader);
      expect(ok.status).toBe(200);

      // 2) 担当外は404（承認済みになった後でも409ではなく404＝担当外判定が先）
      const res = await approve(expense.id, stranger.cookieHeader);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('404 NOT_FOUND: 担当外の承認者の試行で、状態は変わらない', async () => {
      const { manager, expense } = await setupSubmitted('approve-stranger-st');
      const stranger = await createManager('approve-stranger-st-other');

      // 同一IDが担当者には見えている（SUBMITTEDのまま）ことを先に確認
      const visible = await getOne(expense.id, manager.cookieHeader);
      expect(visible.status).toBe(200);

      const res = await approve(expense.id, stranger.cookieHeader);
      expect(res.status).toBe(404);

      const row = await prisma.expenseRequest.findUnique({
        where: { id: expense.id },
      });
      expect(row?.status).toBe(ExpenseStatus.SUBMITTED);
    });

    it('404 NOT_FOUND: 申請者本人は（MANAGERロールがあり自分がapproverIdでも）自分の申請を承認できない', async () => {
      // 比較用：別人が承認者の正常な申請は、その承認者なら200
      const { manager, expense: normal } = await setupSubmitted('approve-self');
      const okRes = await approve(normal.id, manager.cookieHeader);
      expect(okRes.status).toBe(200);

      // 異常データ：applicant=approver=自分（MANAGERロール付き）
      const self = await createManager('approve-self-user');
      const own = await createExpense({
        applicantId: self.userId,
        approverId: self.userId,
      });

      const res = await approve(own.id, self.cookieHeader);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: ErrorCode.NOT_FOUND });
      const row = await prisma.expenseRequest.findUnique({
        where: { id: own.id },
      });
      expect(row?.status).toBe(ExpenseStatus.SUBMITTED);
    });

    it('403 FORBIDDEN: MANAGERロールなしの通常の申請者本人はロールで弾かれる', async () => {
      const { applicant, expense } = await setupSubmitted('approve-applicant');
      const res = await approve(expense.id, applicant.cookieHeader);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: ErrorCode.FORBIDDEN });
    });

    it('404 NOT_FOUND: 存在しないID', async () => {
      // 先に、同じ承認者が実在する担当申請なら承認できる（ルート自体は存在する）ことを確認
      const { manager, expense } = await setupSubmitted('approve-nonexistent');
      const ok = await approve(expense.id, manager.cookieHeader);
      expect(ok.status).toBe(200);

      const res = await approve(NON_EXISTENT_ID, manager.cookieHeader);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('403 FORBIDDEN: MANAGERロールがないと承認できない（状態も変わらない）', async () => {
      const { manager, expense } = await setupSubmitted('approve-norole');
      // 比較：担当のMANAGERには見えている
      const visible = await getOne(expense.id, manager.cookieHeader);
      expect(visible.status).toBe(200);

      // MANAGERロールを持たないが、approverIdに指定されているユーザー
      const noRole = await createApplicant('approve-norole-user', null);
      const own = await createExpense({
        applicantId: manager.userId,
        approverId: noRole.userId,
      });

      const res = await approve(own.id, noRole.cookieHeader);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: ErrorCode.FORBIDDEN });
      const row = await prisma.expenseRequest.findUnique({
        where: { id: own.id },
      });
      expect(row?.status).toBe(ExpenseStatus.SUBMITTED);
    });

    it('401 AUTH_UNAUTHORIZED: 未ログイン', async () => {
      const { expense } = await setupSubmitted('approve-unauth');
      const res = await request(app.getHttpServer())
        .post(`/approvals/${expense.id}/approve`)
        .set('Origin', ALLOWED_ORIGIN);
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: ErrorCode.AUTH_UNAUTHORIZED });
    });

    it('403 FORBIDDEN: 許可されていないOriginからのPOST（CSRF対策）', async () => {
      const { manager, expense } = await setupSubmitted('approve-csrf');
      const res = await approve(
        expense.id,
        manager.cookieHeader,
        DISALLOWED_ORIGIN,
      );
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: ErrorCode.FORBIDDEN });
      const row = await prisma.expenseRequest.findUnique({
        where: { id: expense.id },
      });
      expect(row?.status).toBe(ExpenseStatus.SUBMITTED);
    });

    describe('状態系：SUBMITTED以外は409 CONFLICT_INVALID_STATUS', () => {
      it.each([
        ExpenseStatus.DRAFT,
        ExpenseStatus.APPROVED,
        ExpenseStatus.RETURNED,
        ExpenseStatus.ACCOUNTING_CONFIRMED,
      ])('%s の申請を承認すると409', async (status) => {
        const { manager, applicant, expense } = await setupSubmitted(
          `approve-409-${status.toLowerCase()}`,
        );
        // 先に、同じ担当者がSUBMITTEDなら承認できる構成であることを確認
        const visible = await getOne(expense.id, manager.cookieHeader);
        expect(visible.status).toBe(200);

        const target = await createExpense({
          applicantId: applicant.userId,
          approverId: manager.userId,
          status,
        });
        const res = await approve(target.id, manager.cookieHeader);
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          code: ErrorCode.CONFLICT_INVALID_STATUS,
        });
        const row = await prisma.expenseRequest.findUnique({
          where: { id: target.id },
        });
        expect(row?.status).toBe(status);
      });

      it('二重承認：2回目は409', async () => {
        const { manager, expense } = await setupSubmitted('approve-twice');
        const first = await approve(expense.id, manager.cookieHeader);
        expect(first.status).toBe(200);
        const second = await approve(expense.id, manager.cookieHeader);
        expect(second.status).toBe(409);
        expect(second.body).toMatchObject({
          code: ErrorCode.CONFLICT_INVALID_STATUS,
        });
      });
    });
  });

  // ============================================================
  // POST /approvals/:id/return - 差し戻し
  // ============================================================
  describe('POST /approvals/:id/return - 差し戻し', () => {
    it('正常系：担当の承認者が理由つきで差し戻すと200でRETURNEDになり、理由が保存される', async () => {
      const { manager, expense } = await setupSubmitted('return-ok');

      const res = await returnIt(expense.id, manager.cookieHeader, {
        reason: '領収書を添付してください',
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: expense.id,
        status: ExpenseStatus.RETURNED,
      });
      const row = await prisma.expenseRequest.findUnique({
        where: { id: expense.id },
      });
      expect(row?.status).toBe(ExpenseStatus.RETURNED);
      expect(row?.returnReason).toBe('領収書を添付してください');
    });

    describe('差し戻し理由の検証', () => {
      it('400 VALIDATION_ERROR: reasonなし（状態は変わらない）', async () => {
        const { manager, expense } = await setupSubmitted('return-noreason');
        const res = await returnIt(expense.id, manager.cookieHeader, {});
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
        const row = await prisma.expenseRequest.findUnique({
          where: { id: expense.id },
        });
        expect(row?.status).toBe(ExpenseStatus.SUBMITTED);
      });

      it('400 VALIDATION_ERROR: reasonが空文字', async () => {
        const { manager, expense } = await setupSubmitted('return-empty');
        const res = await returnIt(expense.id, manager.cookieHeader, {
          reason: '',
        });
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
      });

      it('400 VALIDATION_ERROR: reasonが文字列でない', async () => {
        const { manager, expense } = await setupSubmitted('return-nonstr');
        const res = await returnIt(expense.id, manager.cookieHeader, {
          reason: 123,
        });
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
      });

      it('正常系：ちょうど500文字（EXPENSE_RETURN_REASON_MAX_LENGTH）は200', async () => {
        const { manager, expense } = await setupSubmitted('return-500');
        const reason = 'あ'.repeat(EXPENSE_RETURN_REASON_MAX_LENGTH);
        const res = await returnIt(expense.id, manager.cookieHeader, {
          reason,
        });
        expect(res.status).toBe(200);
        const row = await prisma.expenseRequest.findUnique({
          where: { id: expense.id },
        });
        expect(row?.returnReason).toBe(reason);
      });

      it('400 VALIDATION_ERROR: 501文字（状態は変わらない）', async () => {
        const { manager, expense } = await setupSubmitted('return-501');
        const res = await returnIt(expense.id, manager.cookieHeader, {
          reason: 'あ'.repeat(EXPENSE_RETURN_REASON_MAX_LENGTH + 1),
        });
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
        const row = await prisma.expenseRequest.findUnique({
          where: { id: expense.id },
        });
        expect(row?.status).toBe(ExpenseStatus.SUBMITTED);
      });

      it.each([
        ['spaceのみ', 'return-ws-space', '   '],
        ['全角スペースのみ', 'return-ws-zenkaku', '　　'],
        ['改行のみ', 'return-ws-newline', '\n\n'],
        ['スペース・タブ・改行の混在', 'return-ws-mixed', ' \t\n \r\n\t '],
      ])(
        '400 VALIDATION_ERROR: reasonが空白だけ（%s）で、状態は変わらない',
        async (_label, setupKey, reason) => {
          const { manager, expense } = await setupSubmitted(setupKey);
          const res = await returnIt(expense.id, manager.cookieHeader, {
            reason,
          });
          expect(res.status).toBe(400);
          expect(res.body).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
          const row = await prisma.expenseRequest.findUnique({
            where: { id: expense.id },
          });
          expect(row?.status).toBe(ExpenseStatus.SUBMITTED);
          expect(row?.returnReason).toBeNull();
        },
      );

      it('400 VALIDATION_ERROR: 想定外の項目（status等）を送ると拒否され、状態は変わらない', async () => {
        const { manager, expense } = await setupSubmitted('return-extra');
        const res = await returnIt(expense.id, manager.cookieHeader, {
          reason: '理由',
          status: ExpenseStatus.APPROVED,
        });
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
        const row = await prisma.expenseRequest.findUnique({
          where: { id: expense.id },
        });
        expect(row?.status).toBe(ExpenseStatus.SUBMITTED);
      });
    });

    it('404 NOT_FOUND: 担当外の承認者は差し戻せない（先に本来の承認者で同じIDが200になることを確認）', async () => {
      const { manager, expense } = await setupSubmitted('return-stranger');
      const stranger = await createManager('return-stranger-other');

      const ok = await returnIt(expense.id, manager.cookieHeader);
      expect(ok.status).toBe(200);

      const res = await returnIt(expense.id, stranger.cookieHeader);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('404 NOT_FOUND: 担当外の試行で、状態も理由も変わらない', async () => {
      const { manager, expense } = await setupSubmitted('return-stranger-st');
      const stranger = await createManager('return-stranger-st-other');
      const visible = await getOne(expense.id, manager.cookieHeader);
      expect(visible.status).toBe(200);

      const res = await returnIt(expense.id, stranger.cookieHeader);
      expect(res.status).toBe(404);

      const row = await prisma.expenseRequest.findUnique({
        where: { id: expense.id },
      });
      expect(row?.status).toBe(ExpenseStatus.SUBMITTED);
      expect(row?.returnReason).toBeNull();
    });

    it('404 NOT_FOUND: 申請者本人は（MANAGERロールがあり自分がapproverIdでも）自分の申請を差し戻せない', async () => {
      const { manager, expense: normal } = await setupSubmitted('return-self');
      const okRes = await returnIt(normal.id, manager.cookieHeader);
      expect(okRes.status).toBe(200);

      const self = await createManager('return-self-user');
      const own = await createExpense({
        applicantId: self.userId,
        approverId: self.userId,
      });
      const res = await returnIt(own.id, self.cookieHeader);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: ErrorCode.NOT_FOUND });
      const row = await prisma.expenseRequest.findUnique({
        where: { id: own.id },
      });
      expect(row?.status).toBe(ExpenseStatus.SUBMITTED);
    });

    it('404 NOT_FOUND: 存在しないID', async () => {
      // 先に、同じ承認者が実在する担当申請なら差し戻せる（ルート自体は存在する）ことを確認
      const { manager, expense } = await setupSubmitted('return-nonexistent');
      const ok = await returnIt(expense.id, manager.cookieHeader);
      expect(ok.status).toBe(200);

      const res = await returnIt(NON_EXISTENT_ID, manager.cookieHeader);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('403 FORBIDDEN: MANAGERロールがないと差し戻せない', async () => {
      const { manager } = await setupSubmitted('return-norole');
      const noRole = await createApplicant('return-norole-user', null);
      const own = await createExpense({
        applicantId: manager.userId,
        approverId: noRole.userId,
      });
      const res = await returnIt(own.id, noRole.cookieHeader);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: ErrorCode.FORBIDDEN });
      const row = await prisma.expenseRequest.findUnique({
        where: { id: own.id },
      });
      expect(row?.status).toBe(ExpenseStatus.SUBMITTED);
    });

    it('401 AUTH_UNAUTHORIZED: 未ログイン', async () => {
      const { expense } = await setupSubmitted('return-unauth');
      const res = await request(app.getHttpServer())
        .post(`/approvals/${expense.id}/return`)
        .set('Origin', ALLOWED_ORIGIN)
        .send({ reason: '理由' });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: ErrorCode.AUTH_UNAUTHORIZED });
    });

    it('403 FORBIDDEN: 許可されていないOriginからのPOST（CSRF対策）', async () => {
      const { manager, expense } = await setupSubmitted('return-csrf');
      const res = await returnIt(
        expense.id,
        manager.cookieHeader,
        { reason: '理由' },
        DISALLOWED_ORIGIN,
      );
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: ErrorCode.FORBIDDEN });
    });

    describe('状態系：SUBMITTED以外は409 CONFLICT_INVALID_STATUS', () => {
      it.each([
        ExpenseStatus.DRAFT,
        ExpenseStatus.APPROVED,
        ExpenseStatus.RETURNED,
        ExpenseStatus.ACCOUNTING_CONFIRMED,
      ])('%s の申請を差し戻すと409', async (status) => {
        const { manager, applicant, expense } = await setupSubmitted(
          `return-409-${status.toLowerCase()}`,
        );
        const visible = await getOne(expense.id, manager.cookieHeader);
        expect(visible.status).toBe(200);

        const target = await createExpense({
          applicantId: applicant.userId,
          approverId: manager.userId,
          status,
        });
        const res = await returnIt(target.id, manager.cookieHeader);
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          code: ErrorCode.CONFLICT_INVALID_STATUS,
        });
        const row = await prisma.expenseRequest.findUnique({
          where: { id: target.id },
        });
        expect(row?.status).toBe(status);
        expect(row?.returnReason).toBeNull();
      });
    });
  });

  // ============================================================
  // 同時実行
  // ============================================================
  describe('承認と差し戻しの同時実行', () => {
    it('同時に投げると片方だけ200、もう片方は409 CONFLICT_INVALID_STATUS。最終状態は成功した側と一致する', async () => {
      const { manager, expense } = await setupSubmitted('concurrent');

      const [approveRes, returnRes] = await Promise.all([
        approve(expense.id, manager.cookieHeader),
        returnIt(expense.id, manager.cookieHeader, { reason: '同時実行' }),
      ]);

      const statuses = [approveRes.status, returnRes.status].sort();
      expect(statuses).toEqual([200, 409]);

      const loser = approveRes.status === 409 ? approveRes : returnRes;
      expect(loser.body).toMatchObject({
        code: ErrorCode.CONFLICT_INVALID_STATUS,
      });

      const row = await prisma.expenseRequest.findUnique({
        where: { id: expense.id },
      });
      if (approveRes.status === 200) {
        expect(row?.status).toBe(ExpenseStatus.APPROVED);
        expect(row?.returnReason).toBeNull();
      } else {
        expect(row?.status).toBe(ExpenseStatus.RETURNED);
        expect(row?.returnReason).toBe('同時実行');
      }
    });

    it('承認を同時に2回投げても、成功は1回だけ', async () => {
      const { manager, expense } = await setupSubmitted('concurrent-twice');
      const results = await Promise.all([
        approve(expense.id, manager.cookieHeader),
        approve(expense.id, manager.cookieHeader),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    });
  });

  // ============================================================
  // 提出時のapproverId（PBI3のsubmitの挙動変更）と差し戻し→再提出
  // ============================================================
  describe('提出時のapproverId', () => {
    it('正常系：提出するとapproverIdに申請者のその時点のmanagerIdが入り、その承認者の一覧に出る', async () => {
      const manager = await createManager('submit-approver-mgr');
      const applicant = await createApplicant(
        'submit-approver-app',
        manager.userId,
      );
      const draft = await createExpense({
        applicantId: applicant.userId,
        status: ExpenseStatus.DRAFT,
      });

      const res = await request(app.getHttpServer())
        .post(`/expenses/${draft.id}/submit`)
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', applicant.cookieHeader);
      expect(res.status).toBe(200);

      const row = await prisma.expenseRequest.findUnique({
        where: { id: draft.id },
      });
      expect(row?.approverId).toBe(manager.userId);

      const detail = await getOne(draft.id, manager.cookieHeader);
      expect(detail.status).toBe(200);
    });

    it('409 CONFLICT_MANAGER_NOT_SET: managerIdが自分自身のユーザーは提出できない（approverIdも入らない）', async () => {
      const applicant = await createApplicant('submit-self-mgr', null);
      await prisma.user.update({
        where: { id: applicant.userId },
        data: { managerId: applicant.userId },
      });
      const draft = await createExpense({
        applicantId: applicant.userId,
        status: ExpenseStatus.DRAFT,
      });

      const res = await request(app.getHttpServer())
        .post(`/expenses/${draft.id}/submit`)
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', applicant.cookieHeader);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: ErrorCode.CONFLICT_MANAGER_NOT_SET,
      });
      const row = await prisma.expenseRequest.findUnique({
        where: { id: draft.id },
      });
      expect(row?.status).toBe(ExpenseStatus.DRAFT);
      expect(row?.approverId).toBeNull();
    });

    it('差し戻し→編集→再提出で、approverIdは再提出時点の上長になる（上長変更後に再提出）', async () => {
      const oldManager = await createManager('resubmit-old-mgr');
      const newManager = await createManager('resubmit-new-mgr');
      const applicant = await createApplicant(
        'resubmit-app',
        oldManager.userId,
      );
      const draft = await createExpense({
        applicantId: applicant.userId,
        status: ExpenseStatus.DRAFT,
      });

      // 1) 初回提出：approverId = 旧上長
      const submit1 = await request(app.getHttpServer())
        .post(`/expenses/${draft.id}/submit`)
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', applicant.cookieHeader);
      expect(submit1.status).toBe(200);
      const afterSubmit1 = await prisma.expenseRequest.findUnique({
        where: { id: draft.id },
      });
      expect(afterSubmit1?.approverId).toBe(oldManager.userId);

      // 2) 旧上長が差し戻し
      const ret = await returnIt(draft.id, oldManager.cookieHeader, {
        reason: '金額を修正してください',
      });
      expect(ret.status).toBe(200);

      // 3) 上長が変更される
      await prisma.user.update({
        where: { id: applicant.userId },
        data: { managerId: newManager.userId },
      });

      // 4) 申請者が編集
      const edit = await request(app.getHttpServer())
        .put(`/expenses/${draft.id}`)
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', applicant.cookieHeader)
        .send({
          expenseDate: '2026-11-20',
          amount: 1800,
          category: ExpenseCategory.TRANSPORTATION,
          description: '修正後の内容',
        });
      expect(edit.status).toBe(200);

      // 5) 再提出
      const submit2 = await request(app.getHttpServer())
        .post(`/expenses/${draft.id}/submit`)
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', applicant.cookieHeader);
      expect(submit2.status).toBe(200);
      expect(submit2.body).toMatchObject({ status: ExpenseStatus.SUBMITTED });

      const afterSubmit2 = await prisma.expenseRequest.findUnique({
        where: { id: draft.id },
      });
      expect(afterSubmit2?.approverId).toBe(newManager.userId);
      expect(afterSubmit2?.amount).toBe(1800);

      // 6) 新上長には見え、旧上長には見えない（先に新上長で200を確認）
      const newView = await getOne(draft.id, newManager.cookieHeader);
      expect(newView.status).toBe(200);
      const oldView = await getOne(draft.id, oldManager.cookieHeader);
      expect(oldView.status).toBe(404);

      // 7) 旧上長は承認もできない（404）。新上長は承認できる
      const oldApprove = await approve(draft.id, oldManager.cookieHeader);
      expect(oldApprove.status).toBe(404);
      const newApprove = await approve(draft.id, newManager.cookieHeader);
      expect(newApprove.status).toBe(200);
    });
  });
  // ============================================================
  // 提出時：上長が無効（isActive=false）
  // ============================================================
  describe('提出時の上長の有効性', () => {
    const submit = (id: string, cookie: string) =>
      request(app.getHttpServer())
        .post(`/expenses/${id}/submit`)
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', cookie);

    it('409 CONFLICT_MANAGER_NOT_SET: 上長がisActive=falseだと提出できない（上長が有効なら同じ申請者で200）', async () => {
      const manager = await createManager('submit-inactive-mgr');
      const applicant = await createApplicant(
        'submit-inactive-app',
        manager.userId,
      );
      const okDraft = await createExpense({
        applicantId: applicant.userId,
        status: ExpenseStatus.DRAFT,
      });
      const blockedDraft = await createExpense({
        applicantId: applicant.userId,
        status: ExpenseStatus.DRAFT,
      });

      // 1) 上長が有効なら同じ申請者で提出が成功する
      const ok = await submit(okDraft.id, applicant.cookieHeader);
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ status: ExpenseStatus.SUBMITTED });

      // 2) 上長を無効化すると、同じ申請者の別の下書きは提出できない
      await prisma.user.update({
        where: { id: manager.userId },
        data: { isActive: false },
      });
      const res = await submit(blockedDraft.id, applicant.cookieHeader);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: ErrorCode.CONFLICT_MANAGER_NOT_SET,
      });

      // 3) 申請はDRAFTのまま、approverIdも入らない
      const row = await prisma.expenseRequest.findUnique({
        where: { id: blockedDraft.id },
      });
      expect(row?.status).toBe(ExpenseStatus.DRAFT);
      expect(row?.approverId).toBeNull();
    });

    it('409 CONFLICT_MANAGER_NOT_SET: 差し戻し(RETURNED)からの再提出でも、上長が無効ならRETURNEDのまま', async () => {
      const manager = await createManager('resubmit-inactive-mgr');
      const applicant = await createApplicant(
        'resubmit-inactive-app',
        manager.userId,
      );
      const returned = await createExpense({
        applicantId: applicant.userId,
        approverId: manager.userId,
        status: ExpenseStatus.RETURNED,
      });
      await prisma.user.update({
        where: { id: manager.userId },
        data: { isActive: false },
      });

      const res = await submit(returned.id, applicant.cookieHeader);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: ErrorCode.CONFLICT_MANAGER_NOT_SET,
      });
      const row = await prisma.expenseRequest.findUnique({
        where: { id: returned.id },
      });
      expect(row?.status).toBe(ExpenseStatus.RETURNED);
    });
  });

  // ============================================================
  // レスポンスに内部情報を含めない
  // ============================================================
  describe('レスポンスに内部情報を含まない', () => {
    // 内部情報とみなすパターン（大文字小文字は区別しない）
    const LEAK_PATTERNS: RegExp[] = [
      /passwordhash/i,
      /password/i,
      /\bhash\b/i,
      /secret/i,
      /\bstack\b/i,
      /\bat\s+\S+\s*\(.*:\d+:\d+\)/, // スタックトレース行
      /node_modules/i,
      /\.(ts|js):\d+/, // ファイル名:行番号
      /\b(select|insert\s+into|update|delete\s+from)\b[\s\S]*\b(from|set|where|values)\b/i,
      /prisma/i,
      /\bsql\b/i,
    ];

    function expectNoLeak(body: unknown) {
      const text = JSON.stringify(body);
      for (const pattern of LEAK_PATTERNS) {
        expect({ pattern: String(pattern), hit: pattern.test(text) }).toEqual({
          pattern: String(pattern),
          hit: false,
        });
      }
    }

    function expectErrorShape(body: Record<string, unknown>) {
      expect(Object.keys(body).sort()).toEqual(['code', 'message']);
      expect(typeof body.code).toBe('string');
      expect(typeof body.message).toBe('string');
    }

    it('承認の成功レスポンス(200)に内部情報が含まれない', async () => {
      const { manager, expense } = await setupSubmitted('leak-approve');
      const res = await approve(expense.id, manager.cookieHeader);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: expense.id });
      expect(res.body).not.toHaveProperty('passwordHash');
      expect(res.body).not.toHaveProperty('password');
      expectNoLeak(res.body);
    });

    it('差し戻しの成功レスポンス(200)に内部情報が含まれない', async () => {
      const { manager, expense } = await setupSubmitted('leak-return');
      const res = await returnIt(expense.id, manager.cookieHeader, {
        reason: '内容を確認してください',
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: expense.id });
      expect(res.body).not.toHaveProperty('passwordHash');
      expect(res.body).not.toHaveProperty('password');
      expectNoLeak(res.body);
    });

    it('承認・差し戻しのレスポンスに申請者・承認者のユーザーオブジェクト等が丸ごと入っていない', async () => {
      const { manager, applicant, expense } = await setupSubmitted('leak-user');
      const res = await approve(expense.id, manager.cookieHeader);
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body);
      // メールアドレス等のユーザー情報が混入していない
      expect(text).not.toMatch(/@example|@test|email/i);
      expect(res.body).not.toHaveProperty('applicant');
      expect(res.body).not.toHaveProperty('approver');
      expect(text).toContain(applicant.userId); // applicantIdは返してよい
    });

    it('404のエラーレスポンスは{code,message}のみで内部情報を含まない（本来の承認者は200）', async () => {
      const { manager, expense } = await setupSubmitted('leak-404');
      const stranger = await createManager('leak-404-other');
      const ok = await getOne(expense.id, manager.cookieHeader);
      expect(ok.status).toBe(200);

      for (const res of [
        await approve(expense.id, stranger.cookieHeader),
        await returnIt(expense.id, stranger.cookieHeader),
        await approve(NON_EXISTENT_ID, manager.cookieHeader),
      ]) {
        expect(res.status).toBe(404);
        expectErrorShape(res.body);
        expectNoLeak(res.body);
      }
    });

    it('409のエラーレスポンスは{code,message}のみで内部情報を含まない', async () => {
      const { manager, expense } = await setupSubmitted('leak-409');
      const first = await approve(expense.id, manager.cookieHeader);
      expect(first.status).toBe(200);

      for (const res of [
        await approve(expense.id, manager.cookieHeader),
        await returnIt(expense.id, manager.cookieHeader),
      ]) {
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          code: ErrorCode.CONFLICT_INVALID_STATUS,
        });
        expectErrorShape(res.body);
        expectNoLeak(res.body);
      }
    });

    it('400のエラーレスポンスは{code,message}のみで内部情報を含まない（想定外項目・reasonなし）', async () => {
      const { manager, expense } = await setupSubmitted('leak-400');
      const ok = await getOne(expense.id, manager.cookieHeader);
      expect(ok.status).toBe(200);

      for (const body of [
        {},
        { reason: '理由', status: ExpenseStatus.APPROVED },
      ]) {
        const res = await returnIt(expense.id, manager.cookieHeader, body);
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
        expectErrorShape(res.body);
        expectNoLeak(res.body);
      }
    });
  });
});
