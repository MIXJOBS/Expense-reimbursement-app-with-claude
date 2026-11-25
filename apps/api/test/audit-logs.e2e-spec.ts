// PBI6（監査ログ）の受け入れ条件に対応するe2eテスト。
// 仕様：docs/requirements/sprint-3.md の PBI 6 / docs/api/pbi-6.md（PO判断反映済み）
//
// 前提：この時点では audit_logs テーブル・AuditLogService・GET /admin/audit-logs は未実装。
// そのため新規テストは「実装がないため失敗する」ことが想定どおり。
//
// 方針：
// - audit_logs への読み書きは、Prismaモデル（prisma.auditLog）ではなく生SQLで行う。
//   （`prisma generate` 前でも型エラーにならないようにするため。また、テストが
//   「アプリが書いたログ」を独立に読み取る手段になる）
// - 監査ログは追記専用でテストから削除できない。テストは「そのテストで作った
//   ユーザー・申請のID／メール」で絞り込んで検証し、全件数には依存しない。
// - 「ログが増えない」系は、先に同じ構成で正常な操作を行って「ログが増える」ことを
//   確認してから失敗操作を行う（偶然PASSの防止）。
// - ログインは POST /auth/login が IP 単位で 10回/分に制限される（アプリ単位で集計）。
//   ログインを行う describe は専用のアプリインスタンスを起動し、制限に当たらないようにする。
//
// 担当範囲: *.spec.ts / e2e のみ。実装コードは触らない。
import './support/env';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  AUDIT_FORBIDDEN_KEY_PATTERN,
  AUDIT_LOG_PAGE_SIZE,
  AUDIT_SNAPSHOT_FIELDS,
  AuditAction,
  AuditFailureCode,
  AuditResult,
  AuditTargetType,
  ErrorCode,
  ExpenseCategory,
  ExpenseStatus,
  RoleName,
} from '@expense/shared';
import {
  ALLOWED_ORIGIN,
  SESSION_COOKIE_NAME,
  createSessionCookie,
  createUser,
  getRoleByName,
  grantRole,
  uniqueEmail,
} from './support/fixtures';

const NON_EXISTENT_ID = '00000000-0000-4000-8000-000000000000';
const TEST_PASSWORD = 'Audit-Test-Passw0rd-Zq81';
const WRONG_PASSWORD = 'Wrong-Passw0rd-Kx92-never-logged';
const LIST_PATH = '/admin/audit-logs';

interface LogRow {
  id: string;
  occurredAt: Date;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  result: string;
  failureCode: string | null;
  targetType: string;
  targetId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ipAddress: string | null;
}

class RolledBack extends Error {}

describe('Audit logs (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminRoleId: string;
  let applicantRoleId: string;
  let managerRoleId: string;

  let createdUserIds: string[] = [];
  let createdExpenseIds: string[] = [];
  const extraApps: INestApplication[] = [];

  async function bootApp(): Promise<INestApplication> {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const a = moduleFixture.createNestApplication();
    await a.init();
    return a;
  }

  beforeAll(async () => {
    app = await bootApp();
    prisma = app.get(PrismaService);
    adminRoleId = (await getRoleByName(prisma, RoleName.ADMIN)).id;
    applicantRoleId = (await getRoleByName(prisma, RoleName.APPLICANT)).id;
    managerRoleId = (await getRoleByName(prisma, RoleName.MANAGER)).id;
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
    for (const a of extraApps) await a.close();
    await app.close();
  });

  // ---------- 監査ログの読み取り・投入（生SQL） ----------

  async function queryLogs(f: {
    actorUserId?: string;
    actorEmail?: string;
    targetId?: string;
    action?: string;
  }): Promise<LogRow[]> {
    const conds: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (f.actorUserId)
      conds.push(Prisma.sql`"actorUserId" = ${f.actorUserId}::uuid`);
    if (f.actorEmail) conds.push(Prisma.sql`"actorEmail" = ${f.actorEmail}`);
    if (f.targetId) conds.push(Prisma.sql`"targetId" = ${f.targetId}::uuid`);
    if (f.action) conds.push(Prisma.sql`action = ${f.action}`);
    return prisma.$queryRaw<LogRow[]>(
      Prisma.sql`SELECT * FROM audit_logs WHERE ${Prisma.join(conds, ' AND ')} ORDER BY "occurredAt" ASC, id ASC`,
    );
  }

  // 指定した操作者・対象のいずれかに関わるログの総数。
  async function countLogs(actorIds: string[], targetIds: string[] = []) {
    const rows = await prisma.$queryRaw<{ c: bigint }[]>(
      Prisma.sql`SELECT count(*) AS c FROM audit_logs
        WHERE "actorUserId" = ANY(${actorIds}::uuid[]) OR "targetId" = ANY(${targetIds}::uuid[])`,
    );
    return Number(rows[0].c);
  }

  async function insertAuditRow(p: {
    occurredAt?: Date;
    actorUserId?: string | null;
    actorEmail?: string | null;
    action?: string;
    result?: string;
    failureCode?: string | null;
    targetType?: string;
    targetId?: string | null;
  }) {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO audit_logs (id, "occurredAt", "actorUserId", "actorEmail", action, result,
        "failureCode", "targetType", "targetId", before, after, "ipAddress")
      VALUES (gen_random_uuid(), ${p.occurredAt ?? new Date()}::timestamptz,
        ${p.actorUserId ?? null}::uuid, ${p.actorEmail ?? null},
        ${p.action ?? AuditAction.EXPENSE_CREATE}, ${p.result ?? AuditResult.SUCCESS},
        ${p.failureCode ?? null}, ${p.targetType ?? AuditTargetType.EXPENSE_REQUEST},
        ${p.targetId ?? null}::uuid, NULL, NULL, '127.0.0.1')`);
  }

  // ---------- フィクスチャ ----------

  async function newUser(
    prefix: string,
    roles: RoleName[] = [RoleName.APPLICANT],
    opts: { managerId?: string | null } = {},
  ) {
    const user = await createUser(prisma, {
      email: uniqueEmail(prefix),
      password: TEST_PASSWORD,
      managerId: opts.managerId ?? null,
    });
    createdUserIds.push(user.id);
    for (const r of roles) {
      await grantRole(prisma, user.id, (await getRoleByName(prisma, r)).id);
    }
    const session = await createSessionCookie(prisma, user.id);
    return {
      userId: user.id,
      email: user.email,
      cookieHeader: session.cookieHeader,
      sessionId: session.sessionId,
      rawToken: session.rawToken,
    };
  }

  const newAdmin = (p: string) => newUser(p, [RoleName.APPLICANT, RoleName.ADMIN]);
  const newManager = (p: string) =>
    newUser(p, [RoleName.APPLICANT, RoleName.MANAGER]);

  const EXPENSE_VALUES = {
    expenseDate: '2026-11-20',
    amount: 1500,
    category: ExpenseCategory.TRANSPORTATION,
    description: '監査ログテスト用の申請',
  };

  async function newExpense(p: {
    applicantId: string;
    approverId?: string | null;
    status?: ExpenseStatus;
  }) {
    const e = await prisma.expenseRequest.create({
      data: {
        applicantId: p.applicantId,
        approverId: p.approverId ?? null,
        expenseDate: new Date(EXPENSE_VALUES.expenseDate),
        amount: EXPENSE_VALUES.amount,
        category: EXPENSE_VALUES.category,
        description: EXPENSE_VALUES.description,
        status: p.status ?? ExpenseStatus.DRAFT,
      },
    });
    createdExpenseIds.push(e.id);
    return e;
  }

  // manager配下の申請者を作る
  async function newTeam(prefix: string) {
    const manager = await newManager(`${prefix}-mgr`);
    const applicant = await newUser(`${prefix}-app`, [RoleName.APPLICANT], {
      managerId: manager.userId,
    });
    return { manager, applicant };
  }

  // ---------- HTTPヘルパー ----------

  const http = () => request(app.getHttpServer());
  const post = (url: string, cookie?: string) => {
    const r = http().post(url).set('Origin', ALLOWED_ORIGIN);
    return cookie ? r.set('Cookie', cookie) : r;
  };
  const put = (url: string, cookie: string) =>
    http().put(url).set('Origin', ALLOWED_ORIGIN).set('Cookie', cookie);
  const del = (url: string, cookie: string) =>
    http().delete(url).set('Origin', ALLOWED_ORIGIN).set('Cookie', cookie);
  const getList = (cookie: string, query: Record<string, unknown> = {}) =>
    http().get(LIST_PATH).set('Cookie', cookie).query(query as object);

  // ---------- 共通アサーション ----------

  function expectNearNow(d: Date, from: number, to: number) {
    expect(d.getTime()).toBeGreaterThanOrEqual(from - 5000);
    expect(d.getTime()).toBeLessThanOrEqual(to + 5000);
  }

  function expectSnapshotIsSafe(snap: Record<string, unknown> | null) {
    if (snap === null) return;
    for (const [k, v] of Object.entries(snap)) {
      expect(k).not.toMatch(AUDIT_FORBIDDEN_KEY_PATTERN);
      // フラットなJSON（ネストしたオブジェクト・配列は不可。nullは許可）
      expect(v === null || typeof v !== 'object').toBe(true);
    }
  }

  // 成功ログ1件の共通項目（誰が・何に・何を・結果・IP）を検証して返す。
  function expectCommon(
    row: LogRow,
    e: {
      actorUserId: string | null;
      action: string;
      targetType: string;
      targetId: string | null;
      t0: number;
      t1: number;
    },
  ) {
    expect(row.actorUserId).toBe(e.actorUserId);
    expect(row.action).toBe(e.action);
    expect(row.result).toBe(AuditResult.SUCCESS);
    expect(row.failureCode).toBeNull();
    expect(row.targetType).toBe(e.targetType);
    expect(row.targetId).toBe(e.targetId);
    expect(row.actorEmail).toBeNull();
    expect(row.ipAddress).toEqual(expect.stringMatching(/\S/));
    expectNearNow(row.occurredAt, e.t0, e.t1);
    expectSnapshotIsSafe(row.before);
    expectSnapshotIsSafe(row.after);
  }

  // パスワード・passwordHash・セッショントークン・tokenHash・Cookieがログに無いこと。
  async function expectNoSecrets(
    rows: LogRow[],
    extra: { userIds: string[]; rawStrings?: string[] },
  ) {
    const secrets: string[] = [
      TEST_PASSWORD,
      WRONG_PASSWORD,
      SESSION_COOKIE_NAME + '=',
      ...(extra.rawStrings ?? []),
    ];
    const users = await prisma.user.findMany({
      where: { id: { in: extra.userIds } },
      select: { passwordHash: true },
    });
    secrets.push(...users.map((u) => u.passwordHash));
    const sessions = await prisma.session.findMany({
      where: { userId: { in: extra.userIds } },
      select: { tokenHash: true },
    });
    secrets.push(...sessions.map((s) => s.tokenHash));
    const dump = JSON.stringify(rows);
    for (const s of secrets) {
      expect(dump).not.toContain(s);
    }
    expect(dump).not.toMatch(/passwordHash|tokenHash|set-cookie/i);
  }

  // 正常な操作でログが+1になること → 失敗する操作ではログが増えないこと
  async function expectNoLogOnFailure(p: {
    actorIds: string[];
    targetIds?: string[];
    ok: () => Promise<request.Response>;
    okStatus: number;
    fail: () => Promise<request.Response>;
    failStatus: number;
    failCode?: string;
  }) {
    const base = await countLogs(p.actorIds, p.targetIds ?? []);
    const okRes = await p.ok();
    expect(okRes.status).toBe(p.okStatus);
    const afterOk = await countLogs(p.actorIds, p.targetIds ?? []);
    expect(afterOk).toBe(base + 1); // 同じ構成で正常ならログが増える
    const failRes = await p.fail();
    expect(failRes.status).toBe(p.failStatus);
    if (p.failCode) expect(failRes.body).toMatchObject({ code: p.failCode });
    expect(await countLogs(p.actorIds, p.targetIds ?? [])).toBe(afterOk);
  }

  // ============================================================
  // ログイン・ログアウト
  // ============================================================

  describe('ログイン（専用アプリ）', () => {
    let loginApp: INestApplication;
    beforeAll(async () => {
      loginApp = await bootApp();
      extraApps.push(loginApp);
    });
    const login = (email: string, password: string) =>
      request(loginApp.getHttpServer())
        .post('/auth/login')
        .set('Origin', ALLOWED_ORIGIN)
        .send({ email, password });

    it('ログイン成功でLOGIN/SUCCESSのログが1件増える（USER・本人・before/after=null・IPあり）', async () => {
      const u = await newUser('audit-login-ok');
      const before = await countLogs([u.userId], [u.userId]);
      const t0 = Date.now();
      const res = await login(u.email, TEST_PASSWORD);
      const t1 = Date.now();
      expect(res.status).toBe(200);

      expect(await countLogs([u.userId], [u.userId])).toBe(before + 1);
      const rows = await queryLogs({ targetId: u.userId, action: 'LOGIN' });
      expect(rows).toHaveLength(1);
      expectCommon(rows[0], {
        actorUserId: u.userId,
        action: AuditAction.LOGIN,
        targetType: AuditTargetType.USER,
        targetId: u.userId,
        t0,
        t1,
      });
      expect(rows[0].before).toBeNull();
      expect(rows[0].after).toBeNull();
    });

    it('ログイン失敗4種はLOGIN/FAILUREで記録され、failureCode・actorEmail・targetIdが正しい。クライアントには従来どおり同一の401', async () => {
      const bad = await newUser('audit-bad-pw');
      const inactive = await createUser(prisma, {
        email: uniqueEmail('audit-inactive'),
        password: TEST_PASSWORD,
        isActive: false,
      });
      createdUserIds.push(inactive.id);
      const locked = await createUser(prisma, {
        email: uniqueEmail('audit-locked'),
        password: TEST_PASSWORD,
        failedLoginCount: 5,
        lockedUntil: new Date(Date.now() + 15 * 60 * 1000),
      });
      createdUserIds.push(locked.id);
      const unknownEmail = uniqueEmail('audit-unknown');

      const cases = [
        {
          email: unknownEmail,
          code: AuditFailureCode.LOGIN_UNKNOWN_EMAIL,
          targetId: null as string | null,
        },
        {
          email: bad.email,
          code: AuditFailureCode.LOGIN_BAD_PASSWORD,
          targetId: bad.userId as string | null,
        },
        {
          email: inactive.email,
          code: AuditFailureCode.LOGIN_INACTIVE_USER,
          targetId: inactive.id as string | null,
        },
        {
          email: locked.email,
          code: AuditFailureCode.LOGIN_LOCKED,
          targetId: locked.id as string | null,
        },
      ];

      const bodies: unknown[] = [];
      for (const c of cases) {
        const t0 = Date.now();
        const res = await login(c.email, WRONG_PASSWORD);
        const t1 = Date.now();
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({
          code: ErrorCode.AUTH_INVALID_CREDENTIALS,
        });
        bodies.push(res.body);

        const rows = await queryLogs({ actorEmail: c.email });
        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row.action).toBe(AuditAction.LOGIN);
        expect(row.result).toBe(AuditResult.FAILURE);
        expect(row.failureCode).toBe(c.code);
        expect(row.actorUserId).toBeNull();
        expect(row.actorEmail).toBe(c.email);
        expect(row.targetType).toBe(AuditTargetType.USER);
        expect(row.targetId).toBe(c.targetId);
        expect(row.before).toBeNull();
        expect(row.after).toBeNull();
        expect(row.ipAddress).toEqual(expect.stringMatching(/\S/));
        expectNearNow(row.occurredAt, t0, t1);
      }
      for (const b of bodies) expect(b).toEqual(bodies[0]);

      // パスワード違いは failedLoginCount が加算される（記録と同一Txの副作用が生きている）
      const u = await prisma.user.findUnique({ where: { id: bad.userId } });
      expect(u?.failedLoginCount).toBe(1);
    });
  });

  describe('ログイン：機微情報・入力検証（専用アプリ）', () => {
    let loginApp: INestApplication;
    beforeAll(async () => {
      loginApp = await bootApp();
      extraApps.push(loginApp);
    });
    const login = (body: Record<string, unknown>) =>
      request(loginApp.getHttpServer())
        .post('/auth/login')
        .set('Origin', ALLOWED_ORIGIN)
        .send(body);

    it('ログイン成功・失敗後の全ログ行に、パスワード・passwordHash・セッショントークン・Cookie値が含まれない', async () => {
      const u = await newUser('audit-secret');
      const okRes = await login({ email: u.email, password: TEST_PASSWORD });
      expect(okRes.status).toBe(200);
      const setCookie = String(okRes.headers['set-cookie'] ?? '');
      const tokenMatch = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
        setCookie,
      );
      expect(tokenMatch).not.toBeNull();
      const rawToken = tokenMatch![1];

      const failRes = await login({ email: u.email, password: WRONG_PASSWORD });
      expect(failRes.status).toBe(401);

      const rows = [
        ...(await queryLogs({ actorUserId: u.userId })),
        ...(await queryLogs({ actorEmail: u.email })),
      ];
      expect(rows.length).toBeGreaterThanOrEqual(2); // 成功1＋失敗1（空配列での偶然PASS防止）
      await expectNoSecrets(rows, {
        userIds: [u.userId],
        rawStrings: [rawToken, setCookie],
      });
    });

    it('メール形式でない入力（パスワードをメール欄に入れた等）は400で、actorEmailとして記録されない', async () => {
      const u = await newUser('audit-email-field');
      // 同じ構成で正常ならログが増える
      const before = await countLogs([u.userId], [u.userId]);
      expect((await login({ email: u.email, password: TEST_PASSWORD })).status).toBe(
        200,
      );
      expect(await countLogs([u.userId], [u.userId])).toBe(before + 1);

      const notEmail = 'Not-An-Email-Passw0rd-Qw77';
      const res = await login({ email: notEmail, password: 'x' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
      expect(await queryLogs({ actorEmail: notEmail })).toHaveLength(0);
    });
  });

  describe('ログアウト', () => {
    it('ログアウトでLOGOUTのログが1件増える（SESSION・Session.id・本人）。2回目（401）は増えない', async () => {
      const u = await newUser('audit-logout');
      const before = await countLogs([u.userId], [u.sessionId]);
      const t0 = Date.now();
      const res = await post('/auth/logout', u.cookieHeader);
      const t1 = Date.now();
      expect(res.status).toBe(204);

      expect(await countLogs([u.userId], [u.sessionId])).toBe(before + 1);
      const rows = await queryLogs({ targetId: u.sessionId, action: 'LOGOUT' });
      expect(rows).toHaveLength(1);
      expectCommon(rows[0], {
        actorUserId: u.userId,
        action: AuditAction.LOGOUT,
        targetType: AuditTargetType.SESSION,
        targetId: u.sessionId,
        t0,
        t1,
      });
      expect(rows[0].before).toBeNull();
      expect(rows[0].after).toBeNull();
      // セッショントークン・tokenHashは載らない
      await expectNoSecrets(rows, {
        userIds: [u.userId],
        rawStrings: [u.rawToken],
      });

      // すでに失効したセッションでの再ログアウトは401で、ログは増えない
      const again = await post('/auth/logout', u.cookieHeader);
      expect(again.status).toBe(401);
      expect(await countLogs([u.userId], [u.sessionId])).toBe(before + 1);
    });

    it('未ログインのログアウトは401でログが増えない（他ユーザーのログアウトが+1になる構成を先に確認）', async () => {
      const a = await newUser('audit-logout-a');
      const base = await countLogs([a.userId], [a.sessionId]);
      expect((await post('/auth/logout', a.cookieHeader)).status).toBe(204);
      expect(await countLogs([a.userId], [a.sessionId])).toBe(base + 1);

      const res = await post('/auth/logout');
      expect(res.status).toBe(401);
      expect(await countLogs([a.userId], [a.sessionId])).toBe(base + 1);
    });
  });

  // ============================================================
  // ロール付与・剥奪
  // ============================================================

  describe('ロール付与・剥奪', () => {
    it('ロール付与でROLE_GRANTが1件増える（USER・付与された側・差分before/after）', async () => {
      const admin = await newAdmin('audit-grant-admin');
      const target = await newUser('audit-grant-target');
      const before = await countLogs([admin.userId], [target.userId]);

      const t0 = Date.now();
      const res = await post(
        `/admin/users/${target.userId}/roles`,
        admin.cookieHeader,
      ).send({ roleId: managerRoleId });
      const t1 = Date.now();
      expect(res.status).toBe(201);

      expect(await countLogs([admin.userId], [target.userId])).toBe(before + 1);
      const rows = await queryLogs({
        targetId: target.userId,
        action: 'ROLE_GRANT',
      });
      expect(rows).toHaveLength(1);
      expectCommon(rows[0], {
        actorUserId: admin.userId,
        action: AuditAction.ROLE_GRANT,
        targetType: AuditTargetType.USER,
        targetId: target.userId,
        t0,
        t1,
      });
      expect(rows[0].before).toEqual({
        roleId: managerRoleId,
        roleName: RoleName.MANAGER,
        granted: false,
      });
      expect(rows[0].after).toEqual({
        roleId: managerRoleId,
        roleName: RoleName.MANAGER,
        granted: true,
      });
      expect(Object.keys(rows[0].after!).sort()).toEqual(
        [...AUDIT_SNAPSHOT_FIELDS.USER_ROLE].sort(),
      );
      await expectNoSecrets(rows, { userIds: [admin.userId, target.userId] });
    });

    it('すでに保持しているロールの再付与は、ログが増えない（初回付与は+1）', async () => {
      const admin = await newAdmin('audit-regrant-admin');
      const target = await newUser('audit-regrant-target');
      const grant = () =>
        post(`/admin/users/${target.userId}/roles`, admin.cookieHeader).send({
          roleId: managerRoleId,
        });
      const base = await countLogs([admin.userId], [target.userId]);
      expect((await grant()).status).toBe(201);
      expect(await countLogs([admin.userId], [target.userId])).toBe(base + 1);

      const again = await grant(); // 設計書は「204」と書くが現行実装は201を返す想定（報告の曖昧点）
      expect(again.status).toBeGreaterThanOrEqual(200);
      expect(again.status).toBeLessThan(300);
      expect(await countLogs([admin.userId], [target.userId])).toBe(base + 1);
    });

    it('ロール剥奪でROLE_REVOKEが1件増える（granted true→false）', async () => {
      const admin = await newAdmin('audit-revoke-admin');
      const target = await newUser('audit-revoke-target', [
        RoleName.APPLICANT,
        RoleName.MANAGER,
      ]);
      const before = await countLogs([admin.userId], [target.userId]);

      const t0 = Date.now();
      const res = await del(
        `/admin/users/${target.userId}/roles/${managerRoleId}`,
        admin.cookieHeader,
      );
      const t1 = Date.now();
      expect(res.status).toBe(204);

      expect(await countLogs([admin.userId], [target.userId])).toBe(before + 1);
      const rows = await queryLogs({
        targetId: target.userId,
        action: 'ROLE_REVOKE',
      });
      expect(rows).toHaveLength(1);
      expectCommon(rows[0], {
        actorUserId: admin.userId,
        action: AuditAction.ROLE_REVOKE,
        targetType: AuditTargetType.USER,
        targetId: target.userId,
        t0,
        t1,
      });
      expect(rows[0].before).toEqual({
        roleId: managerRoleId,
        roleName: RoleName.MANAGER,
        granted: true,
      });
      expect(rows[0].after).toEqual({
        roleId: managerRoleId,
        roleName: RoleName.MANAGER,
        granted: false,
      });
    });

    describe('失敗した操作ではログが増えない', () => {
      // 正常な付与（別の対象ユーザー）を先に行って+1を確認し、同じ管理者での失敗を検証する
      async function setup(prefix: string) {
        const admin = await newAdmin(`${prefix}-admin`);
        const okTarget = await newUser(`${prefix}-ok`);
        const ok = () =>
          post(`/admin/users/${okTarget.userId}/roles`, admin.cookieHeader).send(
            { roleId: managerRoleId },
          );
        return { admin, okTarget, ok };
      }

      it('自分自身へのロール付与（403）', async () => {
        const { admin, okTarget, ok } = await setup('audit-g-self');
        await expectNoLogOnFailure({
          actorIds: [admin.userId],
          targetIds: [okTarget.userId, admin.userId],
          ok,
          okStatus: 201,
          fail: () =>
            post(`/admin/users/${admin.userId}/roles`, admin.cookieHeader).send({
              roleId: managerRoleId,
            }),
          failStatus: 403,
        });
      });

      it('存在しないユーザーへの付与（404）', async () => {
        const { admin, okTarget, ok } = await setup('audit-g-404');
        await expectNoLogOnFailure({
          actorIds: [admin.userId],
          targetIds: [okTarget.userId, NON_EXISTENT_ID],
          ok,
          okStatus: 201,
          fail: () =>
            post(`/admin/users/${NON_EXISTENT_ID}/roles`, admin.cookieHeader).send(
              { roleId: managerRoleId },
            ),
          failStatus: 404,
        });
      });

      it('不正なボディ・想定外の項目（400）', async () => {
        const { admin, okTarget, ok } = await setup('audit-g-400');
        const other = await newUser('audit-g-400-other');
        await expectNoLogOnFailure({
          actorIds: [admin.userId],
          targetIds: [okTarget.userId, other.userId],
          ok,
          okStatus: 201,
          fail: () =>
            post(`/admin/users/${other.userId}/roles`, admin.cookieHeader).send({
              roleId: managerRoleId,
              granted: true,
            }),
          failStatus: 400,
          failCode: ErrorCode.VALIDATION_ERROR,
        });
      });

      it('ADMIN以外による付与（403）', async () => {
        const { admin, okTarget, ok } = await setup('audit-g-403');
        const nonAdmin = await newManager('audit-g-403-mgr');
        const other = await newUser('audit-g-403-other');
        await expectNoLogOnFailure({
          actorIds: [admin.userId, nonAdmin.userId],
          targetIds: [okTarget.userId, other.userId],
          ok,
          okStatus: 201,
          fail: () =>
            post(`/admin/users/${other.userId}/roles`, nonAdmin.cookieHeader).send(
              { roleId: applicantRoleId },
            ),
          failStatus: 403,
          failCode: ErrorCode.FORBIDDEN,
        });
      });

      it('保持していないロールの剥奪（404）・自分自身の剥奪（403）', async () => {
        const admin = await newAdmin('audit-r-fail');
        const holder = await newUser('audit-r-holder', [
          RoleName.APPLICANT,
          RoleName.MANAGER,
        ]);
        const noRole = await newUser('audit-r-norole');
        await expectNoLogOnFailure({
          actorIds: [admin.userId],
          targetIds: [holder.userId, noRole.userId],
          ok: () =>
            del(
              `/admin/users/${holder.userId}/roles/${managerRoleId}`,
              admin.cookieHeader,
            ),
          okStatus: 204,
          fail: () =>
            del(
              `/admin/users/${noRole.userId}/roles/${managerRoleId}`,
              admin.cookieHeader,
            ),
          failStatus: 404,
        });
        const base = await countLogs([admin.userId], [admin.userId]);
        const self = await del(
          `/admin/users/${admin.userId}/roles/${adminRoleId}`,
          admin.cookieHeader,
        );
        expect(self.status).toBe(403);
        expect(await countLogs([admin.userId], [admin.userId])).toBe(base);
      });
    });
  });

  // ============================================================
  // 申請の作成・編集・削除・提出
  // ============================================================

  describe('申請の作成・編集・削除・提出', () => {
    it('申請の作成でEXPENSE_CREATEが1件増える（before=null、afterはホワイトリスト項目のみ）', async () => {
      const a = await newUser('audit-ex-create');
      const before = await countLogs([a.userId]);
      const t0 = Date.now();
      const res = await post('/expenses', a.cookieHeader).send(EXPENSE_VALUES);
      const t1 = Date.now();
      expect(res.status).toBe(201);
      createdExpenseIds.push(res.body.id);

      expect(await countLogs([a.userId])).toBe(before + 1);
      const rows = await queryLogs({
        targetId: res.body.id,
        action: 'EXPENSE_CREATE',
      });
      expect(rows).toHaveLength(1);
      expectCommon(rows[0], {
        actorUserId: a.userId,
        action: AuditAction.EXPENSE_CREATE,
        targetType: AuditTargetType.EXPENSE_REQUEST,
        targetId: res.body.id,
        t0,
        t1,
      });
      expect(rows[0].before).toBeNull();
      expect(rows[0].after).toMatchObject({
        status: ExpenseStatus.DRAFT,
        ...EXPENSE_VALUES,
        returnReason: null,
      });
      expect(Object.keys(rows[0].after!).sort()).toEqual(
        [...AUDIT_SNAPSHOT_FIELDS.EXPENSE_REQUEST].sort(),
      );
      await expectNoSecrets(rows, { userIds: [a.userId] });
    });

    it('申請の編集でEXPENSE_UPDATEが1件増える（編集前→編集後）', async () => {
      const a = await newUser('audit-ex-update');
      const e = await newExpense({ applicantId: a.userId });
      const before = await countLogs([a.userId], [e.id]);
      const t0 = Date.now();
      const res = await put(`/expenses/${e.id}`, a.cookieHeader).send({
        ...EXPENSE_VALUES,
        amount: 2300,
        description: '編集後の説明',
      });
      const t1 = Date.now();
      expect(res.status).toBe(200);

      expect(await countLogs([a.userId], [e.id])).toBe(before + 1);
      const rows = await queryLogs({ targetId: e.id, action: 'EXPENSE_UPDATE' });
      expect(rows).toHaveLength(1);
      expectCommon(rows[0], {
        actorUserId: a.userId,
        action: AuditAction.EXPENSE_UPDATE,
        targetType: AuditTargetType.EXPENSE_REQUEST,
        targetId: e.id,
        t0,
        t1,
      });
      expect(rows[0].before).toMatchObject({
        status: ExpenseStatus.DRAFT,
        amount: 1500,
        description: EXPENSE_VALUES.description,
      });
      expect(rows[0].after).toMatchObject({
        status: ExpenseStatus.DRAFT,
        amount: 2300,
        description: '編集後の説明',
      });
    });

    it('申請の削除でEXPENSE_DELETEが1件増える（削除前→null）。削除後もログは残る', async () => {
      const a = await newUser('audit-ex-delete');
      const e = await newExpense({ applicantId: a.userId });
      const before = await countLogs([a.userId], [e.id]);
      const t0 = Date.now();
      const res = await del(`/expenses/${e.id}`, a.cookieHeader);
      const t1 = Date.now();
      expect(res.status).toBe(204);

      expect(await countLogs([a.userId], [e.id])).toBe(before + 1);
      const rows = await queryLogs({ targetId: e.id, action: 'EXPENSE_DELETE' });
      expect(rows).toHaveLength(1);
      expectCommon(rows[0], {
        actorUserId: a.userId,
        action: AuditAction.EXPENSE_DELETE,
        targetType: AuditTargetType.EXPENSE_REQUEST,
        targetId: e.id,
        t0,
        t1,
      });
      expect(rows[0].before).toMatchObject({
        status: ExpenseStatus.DRAFT,
        amount: 1500,
        description: EXPENSE_VALUES.description,
      });
      expect(rows[0].after).toBeNull();
    });

    it('申請の提出でEXPENSE_SUBMITが1件増える（status DRAFT→SUBMITTED、approverIdが入る）', async () => {
      const { manager, applicant } = await newTeam('audit-ex-submit');
      const e = await newExpense({ applicantId: applicant.userId });
      const before = await countLogs([applicant.userId], [e.id]);
      const t0 = Date.now();
      const res = await post(`/expenses/${e.id}/submit`, applicant.cookieHeader);
      const t1 = Date.now();
      expect(res.status).toBe(200);

      expect(await countLogs([applicant.userId], [e.id])).toBe(before + 1);
      const rows = await queryLogs({ targetId: e.id, action: 'EXPENSE_SUBMIT' });
      expect(rows).toHaveLength(1);
      expectCommon(rows[0], {
        actorUserId: applicant.userId,
        action: AuditAction.EXPENSE_SUBMIT,
        targetType: AuditTargetType.EXPENSE_REQUEST,
        targetId: e.id,
        t0,
        t1,
      });
      expect(rows[0].before).toMatchObject({
        status: ExpenseStatus.DRAFT,
        approverId: null,
      });
      expect(rows[0].after).toMatchObject({
        status: ExpenseStatus.SUBMITTED,
        approverId: manager.userId,
      });
    });

    describe('失敗した操作ではログが増えない', () => {
      // 正常な作成（+1）を先に行い、同じ申請者での失敗を検証する
      async function okCreate(a: { userId: string; cookieHeader: string }) {
        return async () => {
          const res = await post('/expenses', a.cookieHeader).send(
            EXPENSE_VALUES,
          );
          if (res.body?.id) createdExpenseIds.push(res.body.id);
          return res;
        };
      }

      it('作成：不正な入力・status等の想定外の項目（400）、未ログイン（401）', async () => {
        const a = await newUser('audit-f-create');
        const ok = await okCreate(a);
        await expectNoLogOnFailure({
          actorIds: [a.userId],
          ok,
          okStatus: 201,
          fail: () =>
            post('/expenses', a.cookieHeader).send({
              ...EXPENSE_VALUES,
              status: ExpenseStatus.APPROVED,
            }),
          failStatus: 400,
          failCode: ErrorCode.VALIDATION_ERROR,
        });
        const base = await countLogs([a.userId]);
        expect(
          (await post('/expenses', a.cookieHeader).send({ ...EXPENSE_VALUES, amount: -1 }))
            .status,
        ).toBe(400);
        expect((await post('/expenses').send(EXPENSE_VALUES)).status).toBe(401);
        expect(await countLogs([a.userId])).toBe(base);
      });

      it('編集：他人の申請（404）・提出済みの申請（409）・不正な入力（400）', async () => {
        const a = await newUser('audit-f-update');
        const other = await newUser('audit-f-update-other');
        const mine = await newExpense({ applicantId: a.userId });
        const mine2 = await newExpense({ applicantId: a.userId });
        const theirs = await newExpense({ applicantId: other.userId });
        const submitted = await newExpense({
          applicantId: a.userId,
          status: ExpenseStatus.SUBMITTED,
        });
        const ids = [mine.id, mine2.id, theirs.id, submitted.id];
        const edit = (id: string, body: object = { ...EXPENSE_VALUES, amount: 999 }) =>
          put(`/expenses/${id}`, a.cookieHeader).send(body);

        await expectNoLogOnFailure({
          actorIds: [a.userId, other.userId],
          targetIds: ids,
          ok: () => edit(mine.id),
          okStatus: 200,
          fail: () => edit(theirs.id),
          failStatus: 404,
          failCode: ErrorCode.NOT_FOUND,
        });
        const base = await countLogs([a.userId, other.userId], ids);
        const conflict = await edit(submitted.id);
        expect(conflict.status).toBe(409);
        const invalid = await edit(mine2.id, { ...EXPENSE_VALUES, amount: 0.5 });
        expect(invalid.status).toBe(400);
        const nonExistent = await edit(NON_EXISTENT_ID);
        expect(nonExistent.status).toBe(404);
        expect(await countLogs([a.userId, other.userId], ids)).toBe(base);
      });

      it('削除：他人の申請（404）・提出済みの申請（409）', async () => {
        const a = await newUser('audit-f-delete');
        const other = await newUser('audit-f-delete-other');
        const mine = await newExpense({ applicantId: a.userId });
        const theirs = await newExpense({ applicantId: other.userId });
        const submitted = await newExpense({
          applicantId: a.userId,
          status: ExpenseStatus.SUBMITTED,
        });
        const ids = [mine.id, theirs.id, submitted.id];
        await expectNoLogOnFailure({
          actorIds: [a.userId, other.userId],
          targetIds: ids,
          ok: () => del(`/expenses/${mine.id}`, a.cookieHeader),
          okStatus: 204,
          fail: () => del(`/expenses/${theirs.id}`, a.cookieHeader),
          failStatus: 404,
        });
        const base = await countLogs([a.userId, other.userId], ids);
        expect((await del(`/expenses/${submitted.id}`, a.cookieHeader)).status).toBe(
          409,
        );
        expect(await countLogs([a.userId, other.userId], ids)).toBe(base);
      });

      it('提出：上長未設定（409）・他人の申請（404）・提出済みの再提出（409）', async () => {
        const { applicant } = await newTeam('audit-f-submit');
        const noManager = await newUser('audit-f-submit-nomgr');
        const other = await newUser('audit-f-submit-other');
        const ok1 = await newExpense({ applicantId: applicant.userId });
        const noMgrExpense = await newExpense({ applicantId: noManager.userId });
        const theirs = await newExpense({ applicantId: other.userId });
        const ids = [ok1.id, noMgrExpense.id, theirs.id];
        const actors = [applicant.userId, noManager.userId, other.userId];

        await expectNoLogOnFailure({
          actorIds: actors,
          targetIds: ids,
          ok: () => post(`/expenses/${ok1.id}/submit`, applicant.cookieHeader),
          okStatus: 200,
          fail: () =>
            post(`/expenses/${noMgrExpense.id}/submit`, noManager.cookieHeader),
          failStatus: 409,
        });
        const base = await countLogs(actors, ids);
        expect(
          (await post(`/expenses/${theirs.id}/submit`, applicant.cookieHeader))
            .status,
        ).toBe(404);
        expect(
          (await post(`/expenses/${ok1.id}/submit`, applicant.cookieHeader)).status,
        ).toBe(409);
        expect(await countLogs(actors, ids)).toBe(base);
      });
    });
  });

  // ============================================================
  // 承認・差し戻し
  // ============================================================

  describe('承認・差し戻し', () => {
    async function setupSubmitted(prefix: string) {
      const { manager, applicant } = await newTeam(prefix);
      const e = await newExpense({
        applicantId: applicant.userId,
        approverId: manager.userId,
        status: ExpenseStatus.SUBMITTED,
      });
      return { manager, applicant, e };
    }
    const approve = (id: string, cookie: string) =>
      post(`/approvals/${id}/approve`, cookie);
    const returnIt = (id: string, cookie: string, body: object) =>
      post(`/approvals/${id}/return`, cookie).send(body);

    it('承認でEXPENSE_APPROVEが1件増える（SUBMITTED→APPROVED、承認者が操作者）', async () => {
      const { manager, e } = await setupSubmitted('audit-approve');
      const before = await countLogs([manager.userId], [e.id]);
      const t0 = Date.now();
      const res = await approve(e.id, manager.cookieHeader);
      const t1 = Date.now();
      expect(res.status).toBe(200);

      expect(await countLogs([manager.userId], [e.id])).toBe(before + 1);
      const rows = await queryLogs({ targetId: e.id, action: 'EXPENSE_APPROVE' });
      expect(rows).toHaveLength(1);
      expectCommon(rows[0], {
        actorUserId: manager.userId,
        action: AuditAction.EXPENSE_APPROVE,
        targetType: AuditTargetType.EXPENSE_REQUEST,
        targetId: e.id,
        t0,
        t1,
      });
      expect(rows[0].before).toMatchObject({
        status: ExpenseStatus.SUBMITTED,
        approverId: manager.userId,
        amount: 1500,
      });
      expect(rows[0].after).toMatchObject({
        status: ExpenseStatus.APPROVED,
        approverId: manager.userId,
        amount: 1500,
      });
      expect(Object.keys(rows[0].after!).sort()).toEqual(
        [...AUDIT_SNAPSHOT_FIELDS.EXPENSE_REQUEST].sort(),
      );
    });

    it('差し戻しでEXPENSE_RETURNが1件増える（returnReasonはtrimせず入力どおり記録）', async () => {
      const { manager, e } = await setupSubmitted('audit-return');
      const reason = '  領収書を添付してください  ';
      const before = await countLogs([manager.userId], [e.id]);
      const t0 = Date.now();
      const res = await returnIt(e.id, manager.cookieHeader, { reason });
      const t1 = Date.now();
      expect(res.status).toBe(200);

      expect(await countLogs([manager.userId], [e.id])).toBe(before + 1);
      const rows = await queryLogs({ targetId: e.id, action: 'EXPENSE_RETURN' });
      expect(rows).toHaveLength(1);
      expectCommon(rows[0], {
        actorUserId: manager.userId,
        action: AuditAction.EXPENSE_RETURN,
        targetType: AuditTargetType.EXPENSE_REQUEST,
        targetId: e.id,
        t0,
        t1,
      });
      expect(rows[0].before).toMatchObject({
        status: ExpenseStatus.SUBMITTED,
        returnReason: null,
      });
      expect(rows[0].after).toMatchObject({
        status: ExpenseStatus.RETURNED,
        returnReason: reason,
      });
    });

    it('承認の失敗（権限なし403・担当外404・SUBMITTED以外409）ではログが増えない', async () => {
      const s1 = await setupSubmitted('audit-af1');
      const s2 = await setupSubmitted('audit-af2');
      const ids = [s1.e.id, s2.e.id];
      const actors = [s1.manager.userId, s2.manager.userId, s1.applicant.userId];

      await expectNoLogOnFailure({
        actorIds: actors,
        targetIds: ids,
        ok: () => approve(s1.e.id, s1.manager.cookieHeader),
        okStatus: 200,
        fail: () => approve(s1.e.id, s1.manager.cookieHeader), // 承認済みの再承認
        failStatus: 409,
        failCode: ErrorCode.CONFLICT_INVALID_STATUS,
      });
      const base = await countLogs(actors, ids);
      // MANAGERロールなし（申請者本人）は403
      expect((await approve(s2.e.id, s2.applicant.cookieHeader)).status).toBe(403);
      // 担当外のMANAGERは404
      expect((await approve(s2.e.id, s1.manager.cookieHeader)).status).toBe(404);
      expect((await approve(NON_EXISTENT_ID, s1.manager.cookieHeader)).status).toBe(
        404,
      );
      expect(await countLogs(actors, ids)).toBe(base);
    });

    it('差し戻しの失敗（理由なし400・承認済み409・権限なし403）ではログが増えない', async () => {
      const s1 = await setupSubmitted('audit-rf1');
      const s2 = await setupSubmitted('audit-rf2');
      const ids = [s1.e.id, s2.e.id];
      const actors = [s1.manager.userId, s2.manager.userId, s2.applicant.userId];

      await expectNoLogOnFailure({
        actorIds: actors,
        targetIds: ids,
        ok: () => returnIt(s1.e.id, s1.manager.cookieHeader, { reason: '理由' }),
        okStatus: 200,
        fail: () => returnIt(s1.e.id, s1.manager.cookieHeader, { reason: '再度' }),
        failStatus: 409,
      });
      const base = await countLogs(actors, ids);
      expect((await returnIt(s2.e.id, s2.manager.cookieHeader, {})).status).toBe(
        400,
      );
      expect(
        (
          await returnIt(s2.e.id, s2.manager.cookieHeader, {
            reason: '理由',
            status: 'APPROVED',
          })
        ).status,
      ).toBe(400);
      expect(
        (await returnIt(s2.e.id, s2.applicant.cookieHeader, { reason: '理由' }))
          .status,
      ).toBe(403);
      expect(await countLogs(actors, ids)).toBe(base);
    });

    it('承認と差し戻しの同時実行では、成功ログは1件だけ（敗者のログは無い）', async () => {
      const { manager, e } = await setupSubmitted('audit-race');
      const before = await countLogs([manager.userId], [e.id]);
      const [a, r] = await Promise.all([
        approve(e.id, manager.cookieHeader),
        returnIt(e.id, manager.cookieHeader, { reason: '同時' }),
      ]);
      expect([a.status, r.status].sort()).toEqual([200, 409]);

      expect(await countLogs([manager.userId], [e.id])).toBe(before + 1);
      const rows = await queryLogs({ targetId: e.id });
      expect(rows).toHaveLength(1);
      expect([AuditAction.EXPENSE_APPROVE, AuditAction.EXPENSE_RETURN]).toContain(
        rows[0].action,
      );
      const finalStatus = (
        await prisma.expenseRequest.findUnique({ where: { id: e.id } })
      )?.status;
      expect(rows[0].after).toMatchObject({ status: finalStatus });
    });
  });

  // ============================================================
  // 追記専用（DBトリガー）
  // ============================================================

  describe('追記専用（DBトリガー）', () => {
    async function seedRow() {
      const targetId = crypto.randomUUID();
      await insertAuditRow({ targetId, actorEmail: null });
      const rows = await queryLogs({ targetId });
      expect(rows).toHaveLength(1);
      return { targetId, row: rows[0] };
    }

    // 文を実行し、拒否されること（成功してしまった場合はTxごとロールバックして失敗にする）。
    async function expectRejected(sql: Prisma.Sql) {
      let outcome: unknown;
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw(sql);
          throw new RolledBack('statement succeeded');
        });
      } catch (e) {
        outcome = e;
      }
      expect(outcome).toBeDefined();
      expect(outcome).not.toBeInstanceOf(RolledBack); // RolledBack＝拒否されず成功した
    }

    it('INSERT は成功する（拒否されるのは更新・削除だけ）', async () => {
      const { row } = await seedRow();
      expect(row.id).toBeDefined();
    });

    it('UPDATE が拒否される（行は変わらない）', async () => {
      const { targetId, row } = await seedRow();
      await expectRejected(
        Prisma.sql`UPDATE audit_logs SET action = 'TAMPERED' WHERE "targetId" = ${targetId}::uuid`,
      );
      const after = (await queryLogs({ targetId }))[0];
      expect(after.action).toBe(row.action);
    });

    it('UPDATE（全列・全行を対象にしても）が拒否される', async () => {
      await seedRow();
      await expectRejected(Prisma.sql`UPDATE audit_logs SET "actorUserId" = NULL`);
    });

    it('DELETE が拒否される（行は残る）', async () => {
      const { targetId } = await seedRow();
      await expectRejected(
        Prisma.sql`DELETE FROM audit_logs WHERE "targetId" = ${targetId}::uuid`,
      );
      expect(await queryLogs({ targetId })).toHaveLength(1);
    });

    it('TRUNCATE が拒否される（行は残る）', async () => {
      const { targetId } = await seedRow();
      await expectRejected(Prisma.sql`TRUNCATE TABLE audit_logs`);
      expect(await queryLogs({ targetId })).toHaveLength(1);
    });

    it('アプリのソースにauditLogのupdate/updateMany/upsert/delete/deleteMany呼び出しが無い', () => {
      const srcDir = path.resolve(__dirname, '../src');
      const files: string[] = [];
      const walk = (d: string) => {
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, ent.name);
          if (ent.isDirectory()) walk(p);
          else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) files.push(p);
        }
      };
      walk(srcDir);
      expect(files.length).toBeGreaterThan(0);
      const pattern = /auditLog\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\b/;
      const offenders = files.filter((f) =>
        pattern.test(fs.readFileSync(f, 'utf8')),
      );
      expect(offenders).toEqual([]);
      // 検索が空振りしていないこと：作成の呼び出し口（AuditLogService）は存在するはず
      const hasCreate = files.some((f) =>
        /auditLog\s*\.\s*create\b/.test(fs.readFileSync(f, 'utf8')),
      );
      expect(hasCreate).toBe(true);
    });
  });

  // ============================================================
  // 閲覧API GET /admin/audit-logs
  // ============================================================

  describe(`GET ${LIST_PATH}`, () => {
    describe('認可', () => {
      it('ADMINは200で閲覧できる', async () => {
        const admin = await newAdmin('audit-list-admin');
        const res = await getList(admin.cookieHeader);
        expect(res.status).toBe(200);
      });

      it('未ログインは401 AUTH_UNAUTHORIZED（ADMINなら200の構成を先に確認）', async () => {
        const admin = await newAdmin('audit-list-401');
        expect((await getList(admin.cookieHeader)).status).toBe(200);
        const res = await http().get(LIST_PATH);
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ code: ErrorCode.AUTH_UNAUTHORIZED });
      });

      it.each([
        ['APPLICANTのみ', [RoleName.APPLICANT]],
        ['MANAGER', [RoleName.APPLICANT, RoleName.MANAGER]],
        ['ACCOUNTING', [RoleName.APPLICANT, RoleName.ACCOUNTING]],
        [
          'MANAGER+ACCOUNTING（ADMINなし）',
          [RoleName.APPLICANT, RoleName.MANAGER, RoleName.ACCOUNTING],
        ],
      ])('%s は403 FORBIDDEN', async (_label, roles) => {
        const admin = await newAdmin('audit-list-ok');
        expect((await getList(admin.cookieHeader)).status).toBe(200);
        const u = await newUser('audit-list-403', roles as RoleName[]);
        const res = await getList(u.cookieHeader);
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: ErrorCode.FORBIDDEN });
        expect(res.body.items).toBeUndefined();
      });

      it('POST/PUT/PATCH/DELETE のルートは存在しない（404）。作成APIは公開されない', async () => {
        const admin = await newAdmin('audit-list-methods');
        expect((await getList(admin.cookieHeader)).status).toBe(200);
        const o = (r: request.Test) =>
          r.set('Origin', ALLOWED_ORIGIN).set('Cookie', admin.cookieHeader);
        const body = { action: 'LOGIN', targetType: 'USER' };
        expect((await o(http().post(LIST_PATH)).send(body)).status).toBe(404);
        expect((await o(http().put(LIST_PATH)).send(body)).status).toBe(404);
        expect((await o(http().patch(LIST_PATH)).send(body)).status).toBe(404);
        expect((await o(http().delete(LIST_PATH))).status).toBe(404);
        expect(
          (await o(http().delete(`${LIST_PATH}/${NON_EXISTENT_ID}`))).status,
        ).toBe(404);
      });

      it('閲覧自体はログを増やさない', async () => {
        const admin = await newAdmin('audit-list-noself');
        const base = await countLogs([admin.userId]);
        // 同じ管理者が記録対象の操作（ロール付与）を行うと増える
        const target = await newUser('audit-list-noself-t');
        expect(
          (
            await post(`/admin/users/${target.userId}/roles`, admin.cookieHeader).send(
              { roleId: managerRoleId },
            )
          ).status,
        ).toBe(201);
        expect(await countLogs([admin.userId])).toBe(base + 1);

        expect((await getList(admin.cookieHeader)).status).toBe(200);
        expect((await getList(admin.cookieHeader, { page: 2 })).status).toBe(200);
        expect(await countLogs([admin.userId])).toBe(base + 1);
      });
    });

    describe('レスポンスの形・ページネーション', () => {
      it('{ items, total, page, pageSize } で返り、itemsの項目はDTOどおり。内部情報は含まれない', async () => {
        const admin = await newAdmin('audit-list-shape');
        const targetId = crypto.randomUUID();
        await insertAuditRow({ targetId, actorUserId: admin.userId });

        const res = await getList(admin.cookieHeader, { targetId });
        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(
          ['items', 'page', 'pageSize', 'total'].sort(),
        );
        expect(res.body).toMatchObject({
          total: 1,
          page: 1,
          pageSize: AUDIT_LOG_PAGE_SIZE,
        });
        expect(res.body.items).toHaveLength(1);
        expect(Object.keys(res.body.items[0]).sort()).toEqual(
          [
            'id',
            'occurredAt',
            'actorUserId',
            'actorEmail',
            'action',
            'result',
            'failureCode',
            'targetType',
            'targetId',
            'before',
            'after',
            'ipAddress',
          ].sort(),
        );
        expect(res.body.items[0]).toMatchObject({
          actorUserId: admin.userId,
          targetId,
          action: AuditAction.EXPENSE_CREATE,
          result: AuditResult.SUCCESS,
          targetType: AuditTargetType.EXPENSE_REQUEST,
        });
        expect(new Date(res.body.items[0].occurredAt).toISOString()).toBe(
          res.body.items[0].occurredAt,
        );
        const dump = JSON.stringify(res.body);
        expect(dump).not.toMatch(/passwordHash|tokenHash|stack|SELECT |prisma/i);
      });

      it('実操作のログ（ロール付与）が閲覧APIにbefore/after付きで出る', async () => {
        const admin = await newAdmin('audit-list-e2e');
        const target = await newUser('audit-list-e2e-t');
        expect(
          (
            await post(`/admin/users/${target.userId}/roles`, admin.cookieHeader).send(
              { roleId: managerRoleId },
            )
          ).status,
        ).toBe(201);
        const res = await getList(admin.cookieHeader, {
          targetId: target.userId,
        });
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(1);
        expect(res.body.items[0]).toMatchObject({
          action: AuditAction.ROLE_GRANT,
          actorUserId: admin.userId,
          after: { roleName: RoleName.MANAGER, granted: true },
        });
      });

      it('1ページ50件。51件あると2ページ目に1件出る。範囲外のページは空のitemsで200（totalは実件数）', async () => {
        const admin = await newAdmin('audit-list-page');
        const targetId = crypto.randomUUID();
        await prisma.$executeRaw(Prisma.sql`
          INSERT INTO audit_logs (id, "occurredAt", action, result, "targetType", "targetId")
          SELECT gen_random_uuid(), timestamptz '2026-01-01T00:00:00Z' + (i || ' seconds')::interval,
            'EXPENSE_CREATE', 'SUCCESS', 'EXPENSE_REQUEST', ${targetId}::uuid
          FROM generate_series(0, 50) AS i`);

        const p1 = await getList(admin.cookieHeader, { targetId });
        expect(p1.status).toBe(200);
        expect(p1.body.items).toHaveLength(50);
        expect(p1.body).toMatchObject({ total: 51, page: 1, pageSize: 50 });

        const p2 = await getList(admin.cookieHeader, { targetId, page: 2 });
        expect(p2.body.items).toHaveLength(1);
        expect(p2.body).toMatchObject({ total: 51, page: 2, pageSize: 50 });

        // ページ間で重複・欠落がない
        const ids = [...p1.body.items, ...p2.body.items].map(
          (i: { id: string }) => i.id,
        );
        expect(new Set(ids).size).toBe(51);

        const p3 = await getList(admin.cookieHeader, { targetId, page: 3 });
        expect(p3.status).toBe(200);
        expect(p3.body.items).toEqual([]);
        expect(p3.body).toMatchObject({ total: 51, page: 3 });
      });

      it('並び順は occurredAt 降順、同時刻は id 降順', async () => {
        const admin = await newAdmin('audit-list-order');
        const targetId = crypto.randomUUID();
        const same = new Date('2026-02-01T00:00:00.000Z');
        for (let i = 0; i < 3; i++) await insertAuditRow({ targetId, occurredAt: same });
        await insertAuditRow({
          targetId,
          occurredAt: new Date('2026-03-01T00:00:00.000Z'),
        });
        await insertAuditRow({
          targetId,
          occurredAt: new Date('2026-01-01T00:00:00.000Z'),
        });

        const res = await getList(admin.cookieHeader, { targetId });
        const items = res.body.items as { id: string; occurredAt: string }[];
        expect(items).toHaveLength(5);
        expect(items[0].occurredAt).toBe('2026-03-01T00:00:00.000Z');
        expect(items[4].occurredAt).toBe('2026-01-01T00:00:00.000Z');
        const mid = items.slice(1, 4).map((i) => i.id);
        expect(mid).toEqual([...mid].sort().reverse());
      });
    });

    describe('入力検証（400 VALIDATION_ERROR）', () => {
      it.each([
        ['pageSize（受け付けない）', { pageSize: 10 }],
        ['action（絞り込みに追加しない）', { action: 'LOGIN' }],
        ['result（絞り込みに追加しない）', { result: 'FAILURE' }],
        ['想定外のクエリ', { foo: 'bar' }],
        ['page=0', { page: 0 }],
        ['page=-1', { page: -1 }],
        ['page=10001（上限超え）', { page: 10001 }],
        ['page=abc', { page: 'abc' }],
        ['page=1.5', { page: 1.5 }],
        ['actorUserIdがUUIDでない', { actorUserId: 'not-a-uuid' }],
        ['targetIdがUUIDでない', { targetId: 'not-a-uuid' }],
        ['actorEmailがメール形式でない', { actorEmail: 'not-an-email' }],
        [
          'actorEmailが254文字超',
          { actorEmail: `${'a'.repeat(250)}@example.test` },
        ],
        ['targetTypeが定義外', { targetType: 'HACKED' }],
        ['fromがオフセット無し', { from: '2026-11-01T00:00:00' }],
        ['toがオフセット無し', { to: '2026-11-01T00:00:00' }],
        ['fromが日付だけ', { from: '2026-11-01' }],
        ['fromが不正な文字列', { from: 'yesterday' }],
        [
          'from > to',
          { from: '2026-11-02T00:00:00Z', to: '2026-11-01T00:00:00Z' },
        ],
        [
          'from = to',
          { from: '2026-11-01T00:00:00Z', to: '2026-11-01T00:00:00Z' },
        ],
      ])('%s', async (_label, query) => {
        const admin = await newAdmin('audit-list-400');
        expect((await getList(admin.cookieHeader)).status).toBe(200); // 正常なら200
        const res = await getList(admin.cookieHeader, query);
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
        expect(res.body.items).toBeUndefined();
        expect(JSON.stringify(res.body)).not.toMatch(/stack|SELECT |prisma/i);
      });

      it('SQLインジェクション風の入力は400で、DBエラー（500）にならない', async () => {
        const admin = await newAdmin('audit-list-sqli');
        const res = await getList(admin.cookieHeader, {
          targetId: "'; DROP TABLE audit_logs; --",
          actorEmail: "x'--@example.test",
        });
        expect(res.status).toBe(400);
        // テーブルが無事
        expect((await getList(admin.cookieHeader)).status).toBe(200);
      });
    });

    describe('絞り込み', () => {
      it('actorUserId で絞り込める（他の操作者は出ない）', async () => {
        const admin = await newAdmin('audit-flt-actor');
        const actorA = await newUser('audit-flt-a');
        const actorB = await newUser('audit-flt-b');
        await insertAuditRow({ actorUserId: actorA.userId });
        await insertAuditRow({ actorUserId: actorA.userId });
        await insertAuditRow({ actorUserId: actorB.userId });

        const res = await getList(admin.cookieHeader, {
          actorUserId: actorA.userId,
        });
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(2);
        expect(
          res.body.items.every(
            (i: { actorUserId: string }) => i.actorUserId === actorA.userId,
          ),
        ).toBe(true);
      });

      it('actorEmail は完全一致のみ（部分一致・大文字小文字違いは出ない）', async () => {
        const admin = await newAdmin('audit-flt-email');
        const local = `Flt-${crypto.randomUUID()}`;
        const email = `${local}@Example.test`;
        await insertAuditRow({
          actorEmail: email,
          action: AuditAction.LOGIN,
          result: AuditResult.FAILURE,
          failureCode: AuditFailureCode.LOGIN_BAD_PASSWORD,
          targetType: AuditTargetType.USER,
        });
        await insertAuditRow({
          actorEmail: `x${email}`,
          action: AuditAction.LOGIN,
          result: AuditResult.FAILURE,
          failureCode: AuditFailureCode.LOGIN_UNKNOWN_EMAIL,
          targetType: AuditTargetType.USER,
        });

        const hit = await getList(admin.cookieHeader, { actorEmail: email });
        expect(hit.status).toBe(200);
        expect(hit.body.total).toBe(1);
        expect(hit.body.items[0]).toMatchObject({
          actorEmail: email,
          failureCode: AuditFailureCode.LOGIN_BAD_PASSWORD,
          result: AuditResult.FAILURE,
          actorUserId: null,
        });

        const upper = await getList(admin.cookieHeader, {
          actorEmail: email.toUpperCase(),
        });
        expect(upper.status).toBe(200);
        expect(upper.body.total).toBe(0);
        const lower = await getList(admin.cookieHeader, {
          actorEmail: email.toLowerCase(),
        });
        expect(lower.body.total).toBe(0);
        const prefix = await getList(admin.cookieHeader, {
          actorEmail: `${local}@Example.tes`,
        });
        expect(prefix.status).toBe(200);
        expect(prefix.body.total).toBe(0);
      });

      it('実際のログイン失敗（存在しないメール）が actorEmail で検索できる', async () => {
        const admin = await newAdmin('audit-flt-email-real');
        const unknown = uniqueEmail('audit-flt-unknown');
        const a = await bootApp();
        extraApps.push(a);
        const lr = await request(a.getHttpServer())
          .post('/auth/login')
          .set('Origin', ALLOWED_ORIGIN)
          .send({ email: unknown, password: WRONG_PASSWORD });
        expect(lr.status).toBe(401);

        const res = await getList(admin.cookieHeader, { actorEmail: unknown });
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(1);
        expect(res.body.items[0]).toMatchObject({
          action: AuditAction.LOGIN,
          result: AuditResult.FAILURE,
          failureCode: AuditFailureCode.LOGIN_UNKNOWN_EMAIL,
          actorEmail: unknown,
          targetId: null,
        });
        expect(JSON.stringify(res.body)).not.toContain(WRONG_PASSWORD);
      });

      it('targetType・targetId で絞り込める', async () => {
        const admin = await newAdmin('audit-flt-target');
        const idA = crypto.randomUUID();
        const idB = crypto.randomUUID();
        await insertAuditRow({ targetId: idA, targetType: AuditTargetType.USER });
        await insertAuditRow({
          targetId: idA,
          targetType: AuditTargetType.EXPENSE_REQUEST,
        });
        await insertAuditRow({
          targetId: idB,
          targetType: AuditTargetType.EXPENSE_REQUEST,
        });

        const byId = await getList(admin.cookieHeader, { targetId: idA });
        expect(byId.body.total).toBe(2);
        const both = await getList(admin.cookieHeader, {
          targetId: idA,
          targetType: AuditTargetType.USER,
        });
        expect(both.body.total).toBe(1);
        expect(both.body.items[0]).toMatchObject({
          targetId: idA,
          targetType: AuditTargetType.USER,
        });
        const byType = await getList(admin.cookieHeader, {
          targetType: AuditTargetType.SESSION,
          targetId: idA,
        });
        expect(byType.body.total).toBe(0);
      });

      it('複合条件はANDで効く（actorUserId + actorEmail、実在ユーザーのログイン失敗はactorUserIdがnullなので該当なし）', async () => {
        const admin = await newAdmin('audit-flt-and');
        const u = await newUser('audit-flt-and-u');
        const email = uniqueEmail('audit-flt-and-mail');
        await insertAuditRow({ actorUserId: u.userId });
        await insertAuditRow({
          actorEmail: email,
          action: AuditAction.LOGIN,
          result: AuditResult.FAILURE,
          failureCode: AuditFailureCode.LOGIN_BAD_PASSWORD,
          targetType: AuditTargetType.USER,
          targetId: u.userId,
        });
        expect(
          (await getList(admin.cookieHeader, { actorUserId: u.userId })).body.total,
        ).toBe(1);
        expect(
          (await getList(admin.cookieHeader, { actorEmail: email })).body.total,
        ).toBe(1);
        const both = await getList(admin.cookieHeader, {
          actorUserId: u.userId,
          actorEmail: email,
        });
        expect(both.status).toBe(200);
        expect(both.body.total).toBe(0);
      });

      describe('期間（半開区間 from <= occurredAt < to）', () => {
        async function seedTimes() {
          const targetId = crypto.randomUUID();
          const base = Date.parse('2026-06-01T00:00:00.000Z');
          for (const offsetMs of [0, 1000, 2000]) {
            await insertAuditRow({
              targetId,
              occurredAt: new Date(base + offsetMs),
            });
          }
          return { targetId, base };
        }
        const isoAt = (ms: number) => new Date(ms).toISOString();

        it('fromちょうどは含まれ、toちょうどは含まれない', async () => {
          const admin = await newAdmin('audit-flt-time');
          const { targetId, base } = await seedTimes();
          const res = await getList(admin.cookieHeader, {
            targetId,
            from: isoAt(base),
            to: isoAt(base + 2000),
          });
          expect(res.status).toBe(200);
          expect(res.body.total).toBe(2);
          const times = res.body.items.map((i: { occurredAt: string }) => i.occurredAt);
          expect(times).toEqual([isoAt(base + 1000), isoAt(base)]);
        });

        it('from のみ・to のみでも絞り込める', async () => {
          const admin = await newAdmin('audit-flt-time2');
          const { targetId, base } = await seedTimes();
          const fromOnly = await getList(admin.cookieHeader, {
            targetId,
            from: isoAt(base + 1000),
          });
          expect(fromOnly.body.total).toBe(2);
          const toOnly = await getList(admin.cookieHeader, {
            targetId,
            to: isoAt(base + 1000),
          });
          expect(toOnly.body.total).toBe(1);
        });

        it('+09:00 と Z で同じ瞬間なら同じ結果になる', async () => {
          const admin = await newAdmin('audit-flt-time3');
          const { targetId } = await seedTimes();
          const z = await getList(admin.cookieHeader, {
            targetId,
            from: '2026-06-01T00:00:00Z',
            to: '2026-06-01T00:00:02Z',
          });
          const jst = await getList(admin.cookieHeader, {
            targetId,
            from: '2026-06-01T09:00:00+09:00',
            to: '2026-06-01T09:00:02+09:00',
          });
          expect(z.status).toBe(200);
          expect(jst.status).toBe(200);
          expect(z.body.total).toBe(2); // 空配列同士での偶然一致を防ぐ
          expect(jst.body.items.map((i: { id: string }) => i.id)).toEqual(
            z.body.items.map((i: { id: string }) => i.id),
          );
        });
      });
    });
  });
});
