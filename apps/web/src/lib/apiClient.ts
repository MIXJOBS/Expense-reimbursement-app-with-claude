// apps/api への共通APIクライアントのひな形。
//
// - 認証はCookieセッション（HttpOnly・Secure・SameSite=Lax）前提のため、
//   必ず credentials: 'include' を付けてリクエストする。
// - エラー形式は { code, message } に統一される想定（CLAUDE.md 横断ルール3）。
// - 認証フロー・トークン保持・リトライ等の本格実装は別PBIで行うため、
//   ここでは最低限のGET/POSTラッパーのみ用意する。
//
// パスについて：apps/api側のAuthControllerは @Controller('auth') であり、
// 実際のエンドポイントは /auth/login・/auth/logout・/auth/me で、/api プレフィックスは
// 存在しない（/admin 配下の管理APIも同様）。そのため呼び出し側は '/auth/login' のように
// プレフィックスなしのパスをそのまま渡す想定とし、ここで '/api' を付け足さない
// （vite.config.ts のプロキシ設定も /auth, /admin を対象にしている）。
import type { ApiErrorBody } from '@expense/shared';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body: ApiErrorBody | null = await response.json().catch(() => null);
    throw new ApiError(
      response.status,
      body?.code ?? 'UNKNOWN_ERROR',
      body?.message ?? 'リクエストに失敗しました',
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export const apiClient = {
  get: <T>(path: string) => request<T>(path, { method: 'GET' }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
};
