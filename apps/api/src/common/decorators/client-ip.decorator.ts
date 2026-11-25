import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

// 監査ログに残す操作元IP（req.ip）。TRUST_PROXYを正しく設定しないと
// リバースプロキシのIPになる（configure-app.ts・docs/api/pbi-6.md）。
// X-Forwarded-Forを直接読まない（偽装可能なため）。
export const ClientIp = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return request.ip ?? null;
  },
);
