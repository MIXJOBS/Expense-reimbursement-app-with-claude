import type { RoleName } from '@expense/shared';

// SessionAuthGuard がリクエスト毎にDBから引いた「現在のユーザー」情報。
// セッションにロールをキャッシュしない方針（docs/api/pbi-1-2.md）のため、
// roles は毎リクエストごとに UserRole テーブルから取得した最新値になる。
export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  managerId: string | null;
  roles: RoleName[];
  sessionId: string;
}

// Express の Request に SessionAuthGuard がセットする user の型を拡張する。
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}
