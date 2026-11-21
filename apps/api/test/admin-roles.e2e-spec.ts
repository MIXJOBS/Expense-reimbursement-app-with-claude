// PBI2（ロールと権限）の受け入れ条件に対応するe2eテスト。
//
// 前提：この時点では AdminModule / AdminUsersController / RolesService / RoleGuard 等は
// まだ実装されていない。そのため、本ファイルのテストは「想定どおりに失敗する」
// （404 Not Found や接続エラー等）ことを確認するためのものであり、実装完了後に
// 初めて意味のある合否判定ができるようになる。
//
// ログイン・Cookie取得はログインAPI実装前のため、Sessionレコードを直接Prismaで
// 作成し、そのトークンをCookieとして付与する方式で代用する（test/support/fixtures.ts）。
//
// 実行方法：必ずテスト専用DB（expense_test）に対して実行すること。
// ルートから `pnpm test:e2e:api` を実行すると、.env.test のDATABASE_URLで
// テスト専用DBに向き、事前に pretest:e2e（migrate deploy + db seed）が走る。
// Role マスタ4種は seed で投入済みの前提データであり、本ファイルではcreateしない。
//
// 担当範囲: *.spec.ts / e2e のみ。実装コード（Controller/Service/Guard/main.ts等）は書かない。
import './support/env';
import * as crypto from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ErrorCode, RoleName } from '@expense/shared';
import {
  ALLOWED_ORIGIN,
  DISALLOWED_ORIGIN,
  createSessionCookie,
  createUser,
  deactivateUsersTemporarily,
  findActiveUserIdsWithRole,
  getRoleByName,
  grantRole,
  uniqueEmail,
} from './support/fixtures';

describe('Admin Roles (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let adminRoleId: string;
  let applicantRoleId: string;

  // 各テストが作成したUserのIDをここに積み、afterEachで必ず削除する。
  // assert失敗時でもafterEachは実行されるため、後始末漏れでDBにゴミが
  // 残ることを防ぐ（試験専用DBとはいえ、他テストへの影響を避けるため）。
  let createdUserIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);

    // Roleマスタ（APPLICANT/MANAGER/ACCOUNTING/ADMIN）はテスト実行前のseed
    // （apps/api/prisma/seed.ts、pretest:e2e経由）で投入済みの前提データ。
    adminRoleId = (await getRoleByName(prisma, RoleName.ADMIN)).id;
    applicantRoleId = (await getRoleByName(prisma, RoleName.APPLICANT)).id;
  });

  afterEach(async () => {
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

  describe('未ログイン401', () => {
    it('GET /admin/users はCookie無しで401 AUTH_UNAUTHORIZEDになる', async () => {
      const res = await request(app.getHttpServer()).get('/admin/users');

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: ErrorCode.AUTH_UNAUTHORIZED });
    });

    it('GET /admin/roles はCookie無しで401 AUTH_UNAUTHORIZEDになる', async () => {
      const res = await request(app.getHttpServer()).get('/admin/roles');

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: ErrorCode.AUTH_UNAUTHORIZED });
    });

    it('POST /admin/users/:userId/roles はCookie無しで401 AUTH_UNAUTHORIZEDになる', async () => {
      const res = await request(app.getHttpServer())
        .post(`/admin/users/${crypto.randomUUID()}/roles`)
        .set('Origin', ALLOWED_ORIGIN)
        .send({ roleId: adminRoleId });

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: ErrorCode.AUTH_UNAUTHORIZED });
    });
  });

  describe('権限なし403（ADMINロールを持たない）', () => {
    it('GET /admin/users はAPPLICANTのみのユーザーだと403 FORBIDDENになる', async () => {
      const email = uniqueEmail('non-admin-list');
      const user = await createUser(prisma, { email });
      createdUserIds.push(user.id);
      await grantRole(prisma, user.id, applicantRoleId);
      const { cookieHeader } = await createSessionCookie(prisma, user.id);

      const res = await request(app.getHttpServer())
        .get('/admin/users')
        .set('Cookie', cookieHeader);

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: ErrorCode.FORBIDDEN });
    });

    it('POST /admin/users/:userId/roles はAPPLICANTのみのユーザーだと403 FORBIDDENになる', async () => {
      const actorEmail = uniqueEmail('non-admin-grant-actor');
      const actor = await createUser(prisma, { email: actorEmail });
      createdUserIds.push(actor.id);
      await grantRole(prisma, actor.id, applicantRoleId);
      const { cookieHeader } = await createSessionCookie(prisma, actor.id);

      const targetEmail = uniqueEmail('non-admin-grant-target');
      const target = await createUser(prisma, { email: targetEmail });
      createdUserIds.push(target.id);

      const res = await request(app.getHttpServer())
        .post(`/admin/users/${target.id}/roles`)
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', cookieHeader)
        .send({ roleId: applicantRoleId });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: ErrorCode.FORBIDDEN });
    });
  });

  describe('自分のロール変更403（FORBIDDEN_SELF_ROLE_CHANGE）', () => {
    it('ADMINが自分自身にPOST /admin/users/:selfUserId/rolesすると403 FORBIDDEN_SELF_ROLE_CHANGEになる', async () => {
      const email = uniqueEmail('self-grant-admin');
      const admin = await createUser(prisma, { email });
      createdUserIds.push(admin.id);
      await grantRole(prisma, admin.id, adminRoleId);
      const { cookieHeader } = await createSessionCookie(prisma, admin.id);

      const res = await request(app.getHttpServer())
        .post(`/admin/users/${admin.id}/roles`)
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', cookieHeader)
        .send({ roleId: applicantRoleId });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        code: ErrorCode.FORBIDDEN_SELF_ROLE_CHANGE,
      });
    });

    it('ADMINが自分自身にDELETE /admin/users/:selfUserId/roles/:roleIdすると403 FORBIDDEN_SELF_ROLE_CHANGEになる', async () => {
      const email = uniqueEmail('self-revoke-admin');
      const admin = await createUser(prisma, { email });
      createdUserIds.push(admin.id);
      await grantRole(prisma, admin.id, adminRoleId);
      const { cookieHeader } = await createSessionCookie(prisma, admin.id);

      const res = await request(app.getHttpServer())
        .delete(`/admin/users/${admin.id}/roles/${adminRoleId}`)
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', cookieHeader);

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        code: ErrorCode.FORBIDDEN_SELF_ROLE_CHANGE,
      });
    });
  });

  describe('異常系: 不正な入力・想定外の項目', () => {
    it('POST /admin/users/:userId/roles で roleId が無いと400 VALIDATION_ERRORになる', async () => {
      const email = uniqueEmail('grant-missing-roleid');
      const admin = await createUser(prisma, { email });
      createdUserIds.push(admin.id);
      await grantRole(prisma, admin.id, adminRoleId);
      const { cookieHeader } = await createSessionCookie(prisma, admin.id);

      const targetEmail = uniqueEmail('grant-missing-roleid-target');
      const target = await createUser(prisma, { email: targetEmail });
      createdUserIds.push(target.id);

      const res = await request(app.getHttpServer())
        .post(`/admin/users/${target.id}/roles`)
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', cookieHeader)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    it('POST /admin/users/:userId/roles で想定外の項目(status等)を送ると400 VALIDATION_ERRORになる', async () => {
      const email = uniqueEmail('grant-extra-field');
      const admin = await createUser(prisma, { email });
      createdUserIds.push(admin.id);
      await grantRole(prisma, admin.id, adminRoleId);
      const { cookieHeader } = await createSessionCookie(prisma, admin.id);

      const targetEmail = uniqueEmail('grant-extra-field-target');
      const target = await createUser(prisma, { email: targetEmail });
      createdUserIds.push(target.id);

      const res = await request(app.getHttpServer())
        .post(`/admin/users/${target.id}/roles`)
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', cookieHeader)
        .send({ roleId: applicantRoleId, status: 'APPROVED' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    it('POST /admin/users/:userId/roles で存在しないuserIdを指定すると404 NOT_FOUNDになる', async () => {
      const email = uniqueEmail('grant-notfound-user');
      const admin = await createUser(prisma, { email });
      createdUserIds.push(admin.id);
      await grantRole(prisma, admin.id, adminRoleId);
      const { cookieHeader } = await createSessionCookie(prisma, admin.id);

      const res = await request(app.getHttpServer())
        .post(`/admin/users/${crypto.randomUUID()}/roles`)
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', cookieHeader)
        .send({ roleId: applicantRoleId });

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('他人の付与関係に対するDELETEで、存在しないroleIdを指定すると404 NOT_FOUNDになる', async () => {
      const email = uniqueEmail('revoke-notfound-role');
      const admin = await createUser(prisma, { email });
      createdUserIds.push(admin.id);
      await grantRole(prisma, admin.id, adminRoleId);
      const { cookieHeader } = await createSessionCookie(prisma, admin.id);

      const targetEmail = uniqueEmail('revoke-notfound-role-target');
      const target = await createUser(prisma, { email: targetEmail });
      createdUserIds.push(target.id);

      const res = await request(app.getHttpServer())
        .delete(`/admin/users/${target.id}/roles/${crypto.randomUUID()}`)
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', cookieHeader);

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: ErrorCode.NOT_FOUND });
    });
  });

  describe('CSRF対策: Origin検証', () => {
    it('許可されていないOriginからのPOST /admin/users/:userId/rolesは403 FORBIDDENになる', async () => {
      const email = uniqueEmail('csrf-grant-admin');
      const admin = await createUser(prisma, { email });
      createdUserIds.push(admin.id);
      await grantRole(prisma, admin.id, adminRoleId);
      const { cookieHeader } = await createSessionCookie(prisma, admin.id);

      const targetEmail = uniqueEmail('csrf-grant-target');
      const target = await createUser(prisma, { email: targetEmail });
      createdUserIds.push(target.id);

      const res = await request(app.getHttpServer())
        .post(`/admin/users/${target.id}/roles`)
        .set('Origin', DISALLOWED_ORIGIN)
        .set('Cookie', cookieHeader)
        .send({ roleId: applicantRoleId });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: ErrorCode.FORBIDDEN });
    });
  });

  describe('正常系', () => {
    it('ADMINが他人にPOST /admin/users/:userId/rolesするとロールが付与され201になる', async () => {
      const email = uniqueEmail('grant-ok-admin');
      const admin = await createUser(prisma, { email });
      createdUserIds.push(admin.id);
      await grantRole(prisma, admin.id, adminRoleId);
      const { cookieHeader } = await createSessionCookie(prisma, admin.id);

      const targetEmail = uniqueEmail('grant-ok-target');
      const target = await createUser(prisma, { email: targetEmail });
      createdUserIds.push(target.id);

      const res = await request(app.getHttpServer())
        .post(`/admin/users/${target.id}/roles`)
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', cookieHeader)
        .send({ roleId: applicantRoleId });

      expect(res.status).toBe(201);

      const roleRow = await prisma.userRole.findUnique({
        where: {
          userId_roleId: { userId: target.id, roleId: applicantRoleId },
        },
      });
      expect(roleRow).not.toBeNull();
    });

    it('ADMINが他人にDELETE /admin/users/:userId/roles/:roleIdするとロールが剥奪され204になる', async () => {
      const email = uniqueEmail('revoke-ok-admin');
      const admin = await createUser(prisma, { email });
      createdUserIds.push(admin.id);
      await grantRole(prisma, admin.id, adminRoleId);
      const { cookieHeader } = await createSessionCookie(prisma, admin.id);

      const targetEmail = uniqueEmail('revoke-ok-target');
      const target = await createUser(prisma, { email: targetEmail });
      createdUserIds.push(target.id);
      await grantRole(prisma, target.id, applicantRoleId);

      const res = await request(app.getHttpServer())
        .delete(`/admin/users/${target.id}/roles/${applicantRoleId}`)
        .set('Origin', ALLOWED_ORIGIN)
        .set('Cookie', cookieHeader);

      expect(res.status).toBe(204);

      const roleRow = await prisma.userRole.findUnique({
        where: {
          userId_roleId: { userId: target.id, roleId: applicantRoleId },
        },
      });
      expect(roleRow).toBeNull();
    });

    it('GET /admin/users はADMINユーザーだと200で一覧を返す', async () => {
      const email = uniqueEmail('list-ok-admin');
      const admin = await createUser(prisma, { email });
      createdUserIds.push(admin.id);
      await grantRole(prisma, admin.id, adminRoleId);
      const { cookieHeader } = await createSessionCookie(prisma, admin.id);

      const res = await request(app.getHttpServer())
        .get('/admin/users')
        .set('Cookie', cookieHeader);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body?.items)).toBe(true);
    });

    it('GET /admin/roles はADMINユーザーだと200でロール一覧を返す', async () => {
      const email = uniqueEmail('list-roles-ok-admin');
      const admin = await createUser(prisma, { email });
      createdUserIds.push(admin.id);
      await grantRole(prisma, admin.id, adminRoleId);
      const { cookieHeader } = await createSessionCookie(prisma, admin.id);

      const res = await request(app.getHttpServer())
        .get('/admin/roles')
        .set('Cookie', cookieHeader);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('他人の申請・リソースは404（本ドキュメントの方針：対象ユーザー不存在は404）', () => {
    it('GET /admin/users/:userId/roles で存在しないuserIdを指定すると404 NOT_FOUNDになる', async () => {
      const email = uniqueEmail('getroles-notfound-admin');
      const admin = await createUser(prisma, { email });
      createdUserIds.push(admin.id);
      await grantRole(prisma, admin.id, adminRoleId);
      const { cookieHeader } = await createSessionCookie(prisma, admin.id);

      const res = await request(app.getHttpServer())
        .get(`/admin/users/${crypto.randomUUID()}/roles`)
        .set('Cookie', cookieHeader);

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: ErrorCode.NOT_FOUND });
    });
  });

  describe('同時実行での最後の管理者保護', () => {
    it('管理者がA・B2人のみの状態で、互いが相手のADMINを同時に剥奪しようとすると、片方だけ成功し、もう片方は403になる（FORBIDDEN_LAST_ADMINまたはFORBIDDEN）。管理者はちょうど1人残る', async () => {
      // 本物のADMINロール（seed投入済み）を使う。使い捨てロールでテストすると
      // 実装が本物のADMINロールを正しく参照しているかを検証できないため。
      //
      // ただしDBには seed で投入された初期管理者（admin@example.com）が
      // 既にADMINロールを持って存在する可能性がある。「管理者がA・Bの2人だけ」
      // という前提を確実に成立させるため、テスト開始時点でADMINロールを持つ
      // isActive=trueユーザー（A・B以外）を一時的にisActive=falseにし、
      // テスト終了後（afterEachより前にここで）必ず元に戻す。
      const preExistingAdminUserIds = await findActiveUserIdsWithRole(
        prisma,
        adminRoleId,
      );
      const restorePreExistingAdmins = await deactivateUsersTemporarily(
        prisma,
        preExistingAdminUserIds,
      );

      try {
        const emailA = uniqueEmail('last-admin-a');
        const userA = await createUser(prisma, { email: emailA });
        createdUserIds.push(userA.id);
        await grantRole(prisma, userA.id, adminRoleId);
        const sessionA = await createSessionCookie(prisma, userA.id);

        const emailB = uniqueEmail('last-admin-b');
        const userB = await createUser(prisma, { email: emailB });
        createdUserIds.push(userB.id);
        await grantRole(prisma, userB.id, adminRoleId);
        const sessionB = await createSessionCookie(prisma, userB.id);

        // A が B のADMINを剥奪しようとする
        const reqARevokesB = request(app.getHttpServer())
          .delete(`/admin/users/${userB.id}/roles/${adminRoleId}`)
          .set('Origin', ALLOWED_ORIGIN)
          .set('Cookie', sessionA.cookieHeader);

        // B が A のADMINを剥奪しようとする
        const reqBRevokesA = request(app.getHttpServer())
          .delete(`/admin/users/${userA.id}/roles/${adminRoleId}`)
          .set('Origin', ALLOWED_ORIGIN)
          .set('Cookie', sessionB.cookieHeader);

        const [resARevokesB, resBRevokesA] = await Promise.all([
          reqARevokesB,
          reqBRevokesA,
        ]);

        // 明示的な数値コンパレータでソートする（既定の.sort()は文字列として
        // 辞書順比較されるため、ステータスコードの比較には適さない）。
        const statuses = [resARevokesB.status, resBRevokesA.status].sort(
          (a, b) => a - b,
        );
        expect(statuses).toEqual([204, 403]);

        // 403側のエラーコードは、悲観ロックの実装詳細（競合に負けた方が
        // 「最後の管理者」として具体的に検出されるか、ロック待ち後の再チェックで
        // 単純なFORBIDDENになるか）に依存するため、どちらでも許容する。
        // 本質的な検証ポイントは、この後に確認する「管理者がちょうど1人残る」
        // というDB状態の方である。
        const forbiddenRes =
          resARevokesB.status === 403 ? resARevokesB : resBRevokesA;
        expect([ErrorCode.FORBIDDEN_LAST_ADMIN, ErrorCode.FORBIDDEN]).toContain(
          forbiddenRes.body.code,
        );

        // DBを直接確認：isActive=true かつ ADMINロールを持つユーザーが
        // ちょうど1人であること（A・Bのうち剥奪に成功した側の相手のみが残る）。
        const remainingAdmins = await prisma.userRole.findMany({
          where: {
            roleId: adminRoleId,
            user: { isActive: true },
          },
        });
        expect(remainingAdmins).toHaveLength(1);
      } finally {
        // 一時退避した既存管理者（シード管理者等）を必ず元の状態（isActive=true）に戻す。
        await restorePreExistingAdmins();
      }
    });
  });
});
