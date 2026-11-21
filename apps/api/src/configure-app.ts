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
export function configureApp(app: INestApplication): void {
  // リバースプロキシ配下での本番運用を想定し、X-Forwarded-For等を信頼して
  // req.ip を正しく解決できるようにする（Session.ipAddress の記録・将来のレート
  // リミット等で、プロキシのIPではなく実際のクライアントIPを使うため）。
  // e2eテスト（supertest）はプロキシを経由しないため、この設定が無くても
  // req.ip は直接取得できる値になり、テストの合否には影響しない。
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
}
