import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from './current-user';

// SessionAuthGuard が request.user にセットした「現在のログインユーザー」を
// Controller のハンドラ引数として取り出すためのデコレータ。
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser | undefined => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
