// AuthContext本体（Context定義・型・useAuthフック）。
// react-refresh/only-export-components対策として、コンポーネント（AuthProvider）
// とは別ファイルに分離している。
import { createContext, useContext } from 'react';
import type { CurrentUserDto, LoginRequestBody } from '@expense/shared';

// 画面側で分岐が必要な認証ステータス。
// - 'checking'       : 起動時の GET /auth/me 応答待ち（画面はローディング表示）
// - 'authenticated'  : ログイン済み（user が必ず入る）
// - 'unauthenticated': 未ログイン（ログイン画面を表示する）
export type AuthStatus = 'checking' | 'authenticated' | 'unauthenticated';

export interface AuthContextValue {
  status: AuthStatus;
  user: CurrentUserDto | null;
  login: (body: LoginRequestBody) => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | undefined>(
  undefined,
);

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth は AuthProvider の内側で使用してください');
  }
  return context;
}
