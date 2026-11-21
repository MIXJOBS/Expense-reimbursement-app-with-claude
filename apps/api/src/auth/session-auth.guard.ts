import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ErrorCode } from '@expense/shared';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { SessionsService, SESSION_COOKIE_NAME } from './sessions.service';
import { getRoleNamesForUser } from './user-roles.util';
import { PrismaService } from '../prisma/prisma.service';

// 横断ルール1: 全APIをログイン必須にし、公開APIだけ @Public() で例外にする。
// グローバルガードとして app.module.ts に登録する。
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessionsService: SessionsService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const rawToken = request.cookies?.[SESSION_COOKIE_NAME];

    if (!rawToken || typeof rawToken !== 'string') {
      throw this.unauthorized();
    }

    const result = await this.sessionsService.validateSession(rawToken);
    if (!result) {
      throw this.unauthorized();
    }

    const { session, user } = result;
    const roles = await getRoleNamesForUser(this.prisma, user.id);

    request.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      managerId: user.managerId,
      roles,
      sessionId: session.id,
    };

    return true;
  }

  private unauthorized(): UnauthorizedException {
    return new UnauthorizedException({
      code: ErrorCode.AUTH_UNAUTHORIZED,
      message: 'ログインが必要です。',
    });
  }
}
