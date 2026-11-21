import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // セキュリティヘッダー・Cookieパーサー・ValidationPipe等の共通設定は
  // AppModule（DIコンテナ経由）に持たせており、本番・テストどちらでも
  // AppModuleをimportするだけで同じ設定が有効になる（詳細はconfigure-app.ts参照）。
  // NestApplicationインスタンス特有の追加設定が必要になった場合に備え、
  // 本番起動では必ずconfigureApp(app)を経由する。
  configureApp(app);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
}
bootstrap();
