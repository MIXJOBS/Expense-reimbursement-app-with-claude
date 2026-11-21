import { Response } from 'express';
import { SESSION_COOKIE_NAME } from './sessions.service';

// 決定事項（CLAUDE.md）: 認証はCookieセッション
// （保存先はPostgreSQL、HttpOnly・Secure・SameSite=Lax）。
//
// Secure属性はローカルのプレーンHTTP開発環境ではブラウザに保存されないことがあるが、
// 本番相当の設定を常に使うことを優先し、環境別の切り替えは行わない
// （開発環境もHTTPSリバースプロキシ等を前提とする運用想定）。
const ABSOLUTE_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export function setSessionCookie(res: Response, rawToken: string): void {
  res.cookie(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: ABSOLUTE_SESSION_TTL_MS,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
  });
}
