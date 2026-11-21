import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import * as cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // セキュリティヘッダー（X-Frame-Options, X-Content-Type-Options, HSTS 等）を有効化する。
  app.use(helmet());

  // 決定事項: 認証はCookieセッション（HttpOnly・Secure・SameSite=Lax）。
  // セッションIDの読み取りや将来のCSRFトークン検証（ダブルサブミットクッキー方式等）の下地として
  // cookie-parserを有効化する。セッション管理・CSRF検証の本実装は認証機能のPBIで行う。
  app.use(cookieParser());

  // 横断ルール: 入力検証はDTO + ValidationPipe（whitelist, forbidNonWhitelisted）で行う。
  // 各エンドポイントのDTOはこのグローバル設定に従う。
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
}
bootstrap();
