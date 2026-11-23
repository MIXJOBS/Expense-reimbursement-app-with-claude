import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionsService } from './sessions.service';
import { SessionAuthGuard } from './session-auth.guard';

// ThrottlerModule.forRoot()はIPアドレス単位のレート制限（POST /auth/login専用、
// 1分間に10回まで）に使うストレージ（インメモリ）・デフォルト設定を提供するために
// importする。グローバルにThrottlerGuardをAPP_GUARDとして登録するのではなく、
// AuthControllerのloginメソッドにのみ@UseGuards(ThrottlerGuard)を付与する方式を
// 採用しているため、/auth/logout・/auth/me・/admin/*等の他エンドポイントの挙動は
// 一切変わらない。
@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 10,
      },
    ]),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionsService,
    {
      provide: APP_GUARD,
      useClass: SessionAuthGuard,
    },
  ],
  exports: [AuthService, SessionsService],
})
export class AuthModule {}
