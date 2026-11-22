// /auth 配下のAPI呼び出しをまとめるモジュール。
//
// レスポンス形状はapps/api側の実装に合わせている（apps/api/src/auth/auth.controller.ts参照）：
// - POST /auth/login は { user: CurrentUserDto } でラップされる
//   （Set-Cookieでセッションを渡すため、ボディにはユーザー情報のみ）。
// - GET /auth/me は CurrentUserDto をラップせずそのまま返す。
// - POST /auth/logout は 204 No Content（ボディなし）。
import type {
  CurrentUserDto,
  LoginRequestBody,
  LoginResponseBody,
} from '@expense/shared';
import { apiClient } from '../../lib/apiClient';

export function login(body: LoginRequestBody): Promise<LoginResponseBody> {
  return apiClient.post<LoginResponseBody>('/auth/login', body);
}

export function logout(): Promise<void> {
  return apiClient.post<void>('/auth/logout');
}

export function fetchCurrentUser(): Promise<CurrentUserDto> {
  return apiClient.get<CurrentUserDto>('/auth/me');
}
