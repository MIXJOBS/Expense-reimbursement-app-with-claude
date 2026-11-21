// apps/api への共通APIクライアントのひな形。
//
// - 認証はCookieセッション（HttpOnly・Secure・SameSite=Lax）前提のため、
//   必ず credentials: 'include' を付けてリクエストする。
// - エラー形式は { code, message } に統一される想定（CLAUDE.md 横断ルール3）。
// - 認証フロー・トークン保持・リトライ等の本格実装は別PBIで行うため、
//   ここでは最低限のGET/POSTラッパーのみ用意する。
//
// 使用例が未確定の型は packages/shared 側の実装待ち。
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type {} from '@expense/shared';

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
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
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
