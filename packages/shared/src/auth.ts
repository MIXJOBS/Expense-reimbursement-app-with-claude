import type { RoleName } from './roles';

// GET /auth/me のレスポンス型（フロントとAPIで共有）
export interface CurrentUserDto {
  id: string;
  email: string;
  name: string;
  roles: RoleName[];
  managerId: string | null;
}

// POST /auth/login のリクエストボディ型（プレーンなTS型）。
// class-validatorのデコレータ付きDTOクラスはapps/api側（LoginDto）で別途定義する。
// ここでは型のみをフロント・API間で共有する。
export interface LoginRequestBody {
  email: string;
  password: string;
}

// POST /auth/login 成功時のレスポンス型。
// Cookie(Set-Cookie)でセッションを渡すため、ボディにはユーザー情報のみを含める。
export interface LoginResponseBody {
  user: CurrentUserDto;
}
