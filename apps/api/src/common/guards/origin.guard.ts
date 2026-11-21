import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { ErrorCode } from '@expense/shared';
import { getAllowedOrigins } from '../config/allowed-origins';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// CSRF対策（docs/api/pbi-1-2.md）:
// SPAとAPIが同一サイトである前提のもと、Cookieは SameSite=Lax に加え、
// 状態を変更するリクエスト（POST/PUT/PATCH/DELETE）では Origin ヘッダーを検証し、
// 許可したオリジン以外からのリクエストは 403 FORBIDDEN で拒否する。
// POST /auth/login も対象に含める（@Public() で認証チェックを免除していても、
// このGuardは全リクエストに対してグローバルに適用されるため、ログインCSRF対策になる）。
@Injectable()
export class OriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const method = request.method.toUpperCase();

    if (!STATE_CHANGING_METHODS.has(method)) {
      return true;
    }

    const origin = request.headers.origin;
    const allowedOrigins = getAllowedOrigins();

    if (typeof origin === 'string' && allowedOrigins.has(origin)) {
      return true;
    }

    throw new ForbiddenException({
      code: ErrorCode.FORBIDDEN,
      message: '許可されていないOriginからのリクエストです。',
    });
  }
}
