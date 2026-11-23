import { INestApplication } from '@nestjs/common';

// 本番起動（main.ts）とe2eテスト（test/*.e2e-spec.ts）の両方で設定がズレないようにする
// ための共通関数。
//
// 重要な設計メモ：
// e2eテスト側（test/*.e2e-spec.ts）は `Test.createTestingModule({ imports: [AppModule] })`
// → `app.init()` のみを呼び、configureApp(app) を呼ばない構成になっている
// （このテストファイルは担当範囲外のため変更できない）。そのため、
// 「本番・テストで設定が絶対にズレない」ことを保証するには、main.tsだけが呼ぶ
// configureApp() 側に設定を書くのではなく、AppModule自体（DIコンテナ経由）に
// 設定を持たせる必要がある。具体的には:
//   - helmet / cookie-parser → AppModule（NestModule.configure()でミドルウェアとして登録）
//   - ValidationPipe         → CommonModule（APP_PIPEトークンでグローバル登録）
//   - Origin検証（CSRF対策） → CommonModule（APP_GUARDトークンでOriginGuardを登録）
//   - 統一エラーレスポンス    → CommonModule（APP_FILTERトークンでHttpExceptionFilterを登録）
// これらは AppModule をimportした時点で（app.init()のみでも）必ず有効になるため、
// 本番とテストで設定がズレることはない。
//
// configureApp() 自体は、DIコンテナでは表現できないNestApplicationインスタンス特有の
// ブートストラップ処理のための拡張ポイントとして残している。

// 環境変数 TRUST_PROXY（信頼するプロキシの段数）をパースする。
// - 未設定・空文字 → undefined（trust proxyを設定しない＝Expressのデフォルトfalseのまま）
// - 数値として解釈できない値（空文字以外の不正な文字列、負の数等）→ エラーで起動を止める
//   （SEED_ADMIN_PASSWORD未設定時のfail-fastと同じ考え方。apps/api/prisma/seed.ts参照）
function parseTrustProxy(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      'TRUST_PROXY environment variable must be a non-negative integer ' +
        '(number of trusted reverse proxy hops, e.g. "1"), or unset.',
    );
  }

  return value;
}

export function configureApp(app: INestApplication): void {
  // trust proxyは、クライアントが直接送れるX-Forwarded-For等のヘッダーを
  // どこまで信頼するかを決める設定であり、誤って有効化すると、クライアントが
  // 自分でヘッダーを偽装してreq.ipを詐称できてしまう（Session.ipAddress の記録・
  // ログイン試行レートリミット等がすべて迂回・悪用され得る）。
  //
  // そのため、デフォルト（TRUST_PROXY未設定）ではExpressの既定値であるfalseのまま
  // 変更しない＝クライアントが直接接続している前提で、プロキシ由来ヘッダーは信頼しない。
  // これは開発環境・ロードバランサー無しの本番構成の両方で正しい設定。
  //
  // ロードバランサー等のリバースプロキシ配下で本番運用する場合のみ、
  // TRUST_PROXYに信頼するプロキシの段数（例: "1"）を設定する。数値を渡すことで、
  // Expressは「先頭からN段目までのプロキシだけを信頼する」という安全な動作になる
  // （trueのような「無条件に全部信頼する」設定は使わない）。
  //
  // e2eテスト（supertest）はプロキシを経由せず直接接続するため、TRUST_PROXYを
  // 設定しない（＝trust proxyを呼ばない）デフォルトの挙動でも
  // req.ip は直接取得できる値になり、テストの合否には影響しない。
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  if (trustProxy !== undefined) {
    app.getHttpAdapter().getInstance().set('trust proxy', trustProxy);
  }
}
