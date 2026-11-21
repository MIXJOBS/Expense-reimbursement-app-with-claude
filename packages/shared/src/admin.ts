import type { RoleName } from './roles';

// GET /admin/users/:userId/roles, GET /admin/users 等で使う、ユーザー1件分の型。
export interface AdminUserListItemDto {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  managerId: string | null;
  roles: RoleName[];
}

// GET /admin/users のレスポンス型。
// 今回はページネーションを実装しない（サーバー側で最大100件のハードリミットを
// 設けるのみで、limitはクライアントに公開しない）。将来 hasMore や total 等を
// 追加しやすくするため、配列を直接返す(AdminUserListItemDto[])ではなく
// 一段ラップした形を採用する。
export interface AdminUserListResponseDto {
  items: AdminUserListItemDto[];
}

// GET /admin/roles のレスポンス型。
export interface AdminRoleListItemDto {
  id: string;
  name: RoleName;
}

// POST /admin/users/:userId/roles のリクエストボディ型（プレーンなTS型）。
// class-validatorのデコレータ付きDTOクラス（GrantRoleDto）はapps/api側で別途定義する。
// userId はパスパラメータから取得するため、ボディにはroleIdのみを持たせる。
// 「対象userIdが操作者自身である」ことの検証や「最後のADMIN剥奪防止」の検証は
// DTOのレベルでは行えないため、必ずService層で判定する
// （FORBIDDEN_SELF_ROLE_CHANGE / FORBIDDEN_LAST_ADMIN）。
export interface GrantRoleRequestBody {
  roleId: string;
}
