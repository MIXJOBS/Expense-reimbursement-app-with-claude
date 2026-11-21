import { Module, OnModuleInit } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { OriginGuard } from './guards/origin.guard';
import { HttpExceptionFilter } from './filters/http-exception.filter';
import { createValidationPipe } from './validation-pipe.factory';
import { assertAllowedOriginsConfigured } from './config/allowed-origins';

// 横断的な設定（入力検証、CSRF対策のOrigin検証、統一エラーレスポンス）をまとめるモジュール。
// APP_PIPE/APP_GUARD/APP_FILTERとしてDIコンテナ経由で登録することで、
// 本番起動（main.ts）・e2eテスト（AppModuleをimportしてapp.init()するだけの
// テストアプリ）のどちらでも AppModule をimportした時点で必ず同じ設定が有効になる
// （app.use()やapp.useGlobalPipes()のようなブートストラップ側の呼び出し忘れで
// 設定がズレることを防ぐ）。
// SessionAuthGuard（ログイン必須チェック）は AuthModule 側でグローバル登録する。
// Guardの実行順はNestJSの登録順に依存しないため、OriginGuardとSessionAuthGuardは
// どちらも独立して全リクエストに適用される前提で実装している
// （OriginGuardはOriginヘッダーのみを見るため、認証状態に依存しない）。
@Module({
  providers: [
    {
      provide: APP_PIPE,
      useValue: createValidationPipe(),
    },
    {
      provide: APP_GUARD,
      useClass: OriginGuard,
    },
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class CommonModule implements OnModuleInit {
  // NODE_ENV=production で ALLOWED_ORIGINS が未設定のまま起動することを防ぐための
  // チェック。onModuleInit は Nest のDIコンテナがモジュールを初期化するタイミング
  // （本番起動のNestFactory.create()・e2eテストのTest.createTestingModule().compile()
  // どちらでも必ず呼ばれる）で一度だけ実行されるため、ここでチェックすれば
  // 「本番で許可オリジン未設定のまま動くことを防ぐ」という起動時ガードとして機能する。
  onModuleInit(): void {
    assertAllowedOriginsConfigured();
  }
}
