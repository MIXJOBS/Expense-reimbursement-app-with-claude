import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import helmet from 'helmet';
import * as cookieParser from 'cookie-parser';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PrismaModule,
    CommonModule,
    AuthModule,
    AdminModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  // 本番起動（main.ts経由のconfigureApp）とe2eテスト（AppModuleをimportして
  // app.init()するだけのテストアプリ）の両方で同じミドルウェアが有効になるよう、
  // helmet / cookie-parser はモジュールのconfigure()で登録する
  // （app.use()はブートストラップ側で個別に呼ぶ必要があるが、
  // NestModule.configure()はAppModuleをimportした時点で必ず適用されるため、
  // 本番・テストで設定がズレない）。
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(helmet(), cookieParser()).forRoutes('*');
  }
}
