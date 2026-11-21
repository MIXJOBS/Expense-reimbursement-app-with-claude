// PBI1（ログイン・ログアウト）の受け入れ条件に対応するe2eテスト。
//
// 担当範囲: *.spec.ts / e2e のみ。実装コード（Controller/Service/Guard/main.ts等）は書かない。
import './support/env';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ErrorCode, RoleName } from '@expense/shared';
import {
  ALLOWED_ORIGIN,
  DISALLOWED_ORIGIN,
  createUser,
  getRoleByName,
  grantRole,
  uniqueEmail,
} from './support/fixtures';

// 本物の秘密情報ではない、テスト専用の平文パスワード。
// createUser() に渡し、argon2でハッシュ化されたものがDBに保存される。
const TEST_PASSWORD = 'correct-password-but-unverifiable';

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let applicantRoleId: string;

  // 各テストが作成したUserのIDをここに積み、afterEachで必ず削除する。
  // assert失敗時でもafterEachは実行されるため、後始末漏れでDBにゴミが
  // 残ることを防ぐ（try/finallyより簡潔なため、JestのafterEachを採用）。
  let createdUserIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    // Roleマスタ4種はテスト実行前のseed（apps/api/prisma/seed.ts、pretest:e2e経由）
    // で投入済みの前提データ。テスト側でcreate/upsertはしない。
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

  describe('GET /auth/me', () => {
    it('未ログイン（Cookie無し）の場合は401 AUTH_UNAUTHORIZEDを返す', async () => {
      const res = await request(app.getHttpServer()).get('/auth/me');

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        code: ErrorCode.AUTH_UNAUTHORIZED,
      });
    });
  });

  describe('POST /auth/login - 正常系', () => {
    it('正しいメール・パスワードでログインに成功し、Cookieが発行される', async () => {
      const email = uniqueEmail('login-ok');
      const user = await createUser(prisma, { email, password: TEST_PASSWORD });
      createdUserIds.push(user.id);
      await grantRole(prisma, user.id, applicantRoleId);

      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .set('Origin', ALLOWED_ORIGIN)
        .send({ email, password: TEST_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body?.user?.email).toBe(email);
      expect(res.headers['set-cookie']).toBeDefined();
    });
  });

  describe('POST /auth/login - 異常系: 想定外の入力', () => {
    it('400 VALIDATION_ERROR: emailが無い', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .set('Origin', ALLOWED_ORIGIN)
        .send({ password: 'whatever' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    it('400 VALIDATION_ERROR: passwordが無い', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .set('Origin', ALLOWED_ORIGIN)
        .send({ email: 'someone@example.test' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    it('400 VALIDATION_ERROR: 想定外の項目(role等)を送ると拒否される（forbidNonWhitelisted）', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .set('Origin', ALLOWED_ORIGIN)
        .send({
          email: 'someone@example.test',
          password: 'whatever',
          role: RoleName.ADMIN, // 本来送れないはずのプロパティ
        });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });
  });

  describe('POST /auth/login - ログイン失敗の統一401（ユーザー列挙対策）', () => {
    it('パスワード違い・存在しないユーザー・ロックアウト中・無効化ユーザーが同一の401 AUTH_INVALID_CREDENTIALSになる', async () => {
      const wrongPasswordEmail = uniqueEmail('wrong-password');
      const wrongPasswordUser = await createUser(prisma, {
        email: wrongPasswordEmail,
        password: TEST_PASSWORD,
      });
      createdUserIds.push(wrongPasswordUser.id);

      const lockedEmail = uniqueEmail('locked');
      const lockedUser = await createUser(prisma, {
        email: lockedEmail,
        failedLoginCount: 5,
        lockedUntil: new Date(Date.now() + 15 * 60 * 1000),
      });
      createdUserIds.push(lockedUser.id);

      const inactiveEmail = uniqueEmail('inactive');
      const inactiveUser = await createUser(prisma, {
        email: inactiveEmail,
        isActive: false,
      });
      createdUserIds.push(inactiveUser.id);

      const nonExistentEmail = uniqueEmail('does-not-exist');

      const requests = [
        { email: wrongPasswordEmail, password: 'definitely-wrong' },
        { email: nonExistentEmail, password: 'anything' },
        { email: lockedEmail, password: 'anything' },
        { email: inactiveEmail, password: 'anything' },
      ];

      const responses = await Promise.all(
        requests.map((body) =>
          request(app.getHttpServer())
            .post('/auth/login')
            .set('Origin', ALLOWED_ORIGIN)
            .send(body),
        ),
      );

      for (const res of responses) {
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({
          code: ErrorCode.AUTH_INVALID_CREDENTIALS,
        });
      }

      // 4パターンのレスポンスボディが完全に一致すること（列挙攻撃の手がかりを与えない）
      const bodies = responses.map((res) => res.body);
      expect(bodies[0]).toEqual(bodies[1]);
      expect(bodies[0]).toEqual(bodies[2]);
      expect(bodies[0]).toEqual(bodies[3]);
    });
  });

  describe('CSRF対策: Origin検証', () => {
    it('許可されていないOriginからのPOST /auth/loginは403 FORBIDDENになる', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .set('Origin', DISALLOWED_ORIGIN)
        .send({ email: 'someone@example.test', password: 'whatever' });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: ErrorCode.FORBIDDEN });
    });
  });

  describe('POST /auth/logout', () => {
    it('未ログイン（Cookie無し）で呼ぶと401 AUTH_UNAUTHORIZEDになる', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Origin', ALLOWED_ORIGIN);

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: ErrorCode.AUTH_UNAUTHORIZED });
    });

    it('許可されていないOriginからのPOST /auth/logoutは403 FORBIDDENになる', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Origin', DISALLOWED_ORIGIN);

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: ErrorCode.FORBIDDEN });
    });
  });
});
