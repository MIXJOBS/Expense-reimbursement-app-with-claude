import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ErrorCode, type RoleName } from '@expense/shared';
import { ROLES_KEY } from './roles.decorator';

// 横断ルール1: ロールの有無はGuardで判定する（本人チェックはServiceで行う）。
// SessionAuthGuard（グローバルガード）が request.user.roles をセットした後に
// 実行される前提（roles はリクエスト毎にDBから引いた最新値。
// セッションにロールをキャッシュしない方針のため、ロールを外された次の
// リクエストから即座に403になる）。
@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<
      RoleName[] | undefined
    >(ROLES_KEY, [context.getHandler(), context.getClass()]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const userRoles = request.user?.roles ?? [];

    const hasRequiredRole = requiredRoles.some((role) =>
      userRoles.includes(role),
    );

    if (!hasRequiredRole) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'この操作を行う権限がありません。',
      });
    }

    return true;
  }
}
