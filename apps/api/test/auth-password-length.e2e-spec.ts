// PBI6（PO判断：マージ保留への回答）ログインのパスワード長の境界テスト。
// LoginDto の @MaxLength(256) に対し、256文字は通り、257文字は400になることを確認する。
//
// どちらのケースも「送るパスワードと一致するハッシュを持つユーザー」を作る。
// - 256文字: ログイン成功まで確認し、バリデーション通過を確実にする。
// - 257文字: 認証情報自体は正しいので、400は長さの検証によるものだと分かる。
//
// ログインのレート制限（IP単位 1分10回）はアプリのインスタンスごとにメモリで数える。
// auth.e2e-spec.ts の回数を増やして不安定にしないよう、別ファイル（別インスタンス）にする。
import './support/env';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ErrorCode, RoleName } from '@expense/shared';
import {
  ALLOWED_ORIGIN,
  createUser,
  getRoleByName,
  grantRole,
  uniqueEmail,
} from './support/fixtures';

const MAX_PASSWORD_LENGTH = 256;

describe('Auth パスワード長の境界 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let applicantRoleId: string;
  let createdUserIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
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

  async function createUserWithPasswordLength(length: number) {
    const email = uniqueEmail(`password-${length}`);
    const password = 'a'.repeat(length);
    const user = await createUser(prisma, { email, password });
    createdUserIds.push(user.id);
    await grantRole(prisma, user.id, applicantRoleId);
    return { id: user.id, email, password };
  }

  it('256文字のパスワードはバリデーションを通過し、ログインに成功する', async () => {
    const { email, password } =
      await createUserWithPasswordLength(MAX_PASSWORD_LENGTH);

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .set('Origin', ALLOWED_ORIGIN)
      .send({ email, password });

    expect(password).toHaveLength(256);
    expect(res.status).toBe(200);
    expect(res.body?.user?.email).toBe(email);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('257文字のパスワードは、認証情報が正しくても400 VALIDATION_ERRORになり、セッションを発行しない', async () => {
    const { id, email, password } = await createUserWithPasswordLength(
      MAX_PASSWORD_LENGTH + 1,
    );

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .set('Origin', ALLOWED_ORIGIN)
      .send({ email, password });

    expect(password).toHaveLength(257);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    // エラーレスポンスに入力されたパスワードを含めない
    expect(JSON.stringify(res.body)).not.toContain(password);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await prisma.session.count({ where: { userId: id } })).toBe(0);
  });
});
