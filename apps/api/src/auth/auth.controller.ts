import {
  Controller,
  Post,
  Get,
  Body,
  HttpCode,
  HttpStatus,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { CurrentUserDto, LoginResponseBody } from '@expense/shared';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from './current-user.decorator';
import type { AuthenticatedUser } from './current-user';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { setSessionCookie, clearSessionCookie } from './session-cookie.util';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // 公開API（@Public）だが、CSRF対策のOrigin検証（OriginGuard、状態変更系メソッド対象）は
  // 未ログイン状態でも適用される（ログインCSRF攻撃対策）。
  // IPアドレス単位のレート制限（1分間に10回まで、11回目で429 TOO_MANY_REQUESTS）を
  // このエンドポイントのみに適用する。ThrottlerGuardはこのメソッドにのみ付けており、
  // 他のエンドポイント（/auth/logout, /auth/me, /admin/* 等）には一切影響しない。
  // メールアドレス単位のアカウントロックアウト（5回失敗で15分ロック）とは別軸であり、
  // そちらのロジック（AuthService.login内）は変更していない。
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponseBody> {
    const { user, rawToken } = await this.authService.login(
      dto.email,
      dto.password,
      { userAgent: req.headers['user-agent'] ?? null, ipAddress: req.ip },
    );

    setSessionCookie(res, rawToken);

    return { user };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.authService.logout(currentUser.sessionId);
    clearSessionCookie(res);
  }

  @Get('me')
  async me(
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<CurrentUserDto> {
    return this.authService.getCurrentUser(currentUser.id);
  }
}
