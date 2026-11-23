// IPアドレス単位のログインエンドポイント レート制限に関するe2eテスト。
//
// 担当範囲: *.spec.ts / e2e のみ。実装コード（Controller/Service/Guard/main.ts等）は書かない。
//
// auth.e2e-spec.ts とは別ファイルにしているのは、同一ファイル内で既に
// 複数回 POST /auth/login を呼んでいる既存テストと、このファイルで検証したい
// 「1分間に10回まで許可・11回目で429」というIPアドレス単位の呼び出し回数を
// 混在させないため。別ファイル＝別の Test.createTestingModule / Nestアプリ
// インスタンスとなるため、レート制限のインメモリカウンタも独立している前提で書く。
//
// ここで検証するのは「IPアドレス単位」の制限であり、既存の
// auth.e2e-spec.ts にあるメールアドレス単位のアカウントロックアウト
// （5回失敗で15分ロック、常に401 AUTH_INVALID_CREDENTIALS）とは別軸。
// 1〜10回目は通常のログイン失敗処理（401 AUTH_INVALID_CREDENTIALS）が
// 実行され、11回目でレート制限（429 TOO_MANY_REQUESTS）に切り替わることを確認する。
import './support/env';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { ErrorCode } from '@expense/shared';
import { ALLOWED_ORIGIN, uniqueEmail } from './support/fixtures';

// packages/shared/src/errors.ts の ErrorCode にはまだ
// TOO_MANY_REQUESTS が定義されていない（実装側でこのタスク用に追加される前提）。
// そのため文字列リテラルで期待値を書く。
const TOO_MANY_REQUESTS_CODE = 'TOO_MANY_REQUESTS';

describe('Auth rate limit (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /auth/login - レート制限（IPアドレス単位）', () => {
    it(
      '同一IPから1分間に11回ログインを試みると、1〜10回目は通常の401、' +
        '11回目は429 TOO_MANY_REQUESTSになる',
      async () => {
        // 存在しないメールアドレス（毎回同じでよい。IP単位の制限であり、
        // メールアドレス単位のアカウントロックアウトとは別軸のため）。
        const nonExistentEmail = uniqueEmail('rate-limit-does-not-exist');

        const responses: request.Response[] = [];
        // Promise.all ではなく、回数カウントを厳密に検証するために
        // 1件ずつ逐次 await で送信する。
        for (let i = 0; i < 11; i += 1) {
          const res = await request(app.getHttpServer())
            .post('/auth/login')
            .set('Origin', ALLOWED_ORIGIN)
            .send({ email: nonExistentEmail, password: 'anything' });
          responses.push(res);
        }

        // 1〜10回目: レート制限にはまだ引っかからず、既存の統一401仕様
        // （ユーザー列挙対策）に従って通常のログイン失敗処理が実行される。
        for (let i = 0; i < 10; i += 1) {
          const res = responses[i];
          expect(res.status).toBe(401);
          expect(res.body).toMatchObject({
            code: ErrorCode.AUTH_INVALID_CREDENTIALS,
          });
        }

        // 11回目: IPアドレス単位のレート制限に引っかかり、429になる。
        const eleventh = responses[10];
        expect(eleventh.status).toBe(429);
        expect(eleventh.body).toMatchObject({
          code: TOO_MANY_REQUESTS_CODE,
        });
        expect(typeof eleventh.body.message).toBe('string');
        expect(eleventh.body.message.length).toBeGreaterThan(0);
      },
    );
  });
});
