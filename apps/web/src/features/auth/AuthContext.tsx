// 認証状態（ログイン中ユーザー情報）を画面全体で共有するためのProvider。
//
// 設計方針：
// - セッションの実体はサーバー側のCookie（HttpOnly）であり、フロント側では
//   「現在ログイン中かどうか・誰か」というUI表示用の状態のみを保持する
//   （認証情報自体をlocalStorage等に保存しない。CLAUDE.md / タスク制約を参照）。
// - 画面初期表示時に一度だけ GET /auth/me を呼び、Cookieが有効かどうかを判定する
//   （未ログイン状態でホーム画面にアクセス → 401 を検知 → ログイン画面に戻す、
//   という最低限のルーティング保護のため）。
// - ログイン成功時は POST /auth/login のレスポンスに含まれる user をそのまま
//   状態にセットし、直後に GET /auth/me を呼び直すような無駄な通信はしない。
// - ログアウト時は POST /auth/logout を呼び、成功したらローカルの状態をクリアする。
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { CurrentUserDto, LoginRequestBody } from '@expense/shared';
import { ApiError } from '../../lib/apiClient';
import {
  fetchCurrentUser,
  login as loginRequest,
  logout as logoutRequest,
} from './authApi';
import { AuthContext, type AuthContextValue, type AuthStatus } from './useAuth';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('checking');
  const [user, setUser] = useState<CurrentUserDto | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetchCurrentUser()
      .then((currentUser) => {
        if (cancelled) return;
        setUser(currentUser);
        setStatus('authenticated');
      })
      .catch(() => {
        // 401（未ログイン・セッション失効）以外のエラーでも、ホーム画面は
        // 表示できないため未ログイン扱いにする（詳細なエラー種別の分岐はしない）。
        if (cancelled) return;
        setUser(null);
        setStatus('unauthenticated');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (body: LoginRequestBody) => {
    const { user: loggedInUser } = await loginRequest(body);
    setUser(loggedInUser);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    try {
      await logoutRequest();
    } catch (error) {
      // すでにセッションが失効している（401）場合も、ログイン画面に戻す
      // という観点では成功と同じ扱いにする。それ以外のエラーは呼び出し元に伝える。
      if (!(error instanceof ApiError && error.status === 401)) {
        throw error;
      }
    } finally {
      setUser(null);
      setStatus('unauthenticated');
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, login, logout }),
    [status, user, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
