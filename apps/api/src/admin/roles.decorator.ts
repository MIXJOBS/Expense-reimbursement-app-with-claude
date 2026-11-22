import { SetMetadata } from '@nestjs/common';
import type { RoleName } from '@expense/shared';

// 横断ルール1: ロールの有無はGuard（RoleGuard）で判定する。
// このデコレータでハンドラ/コントローラに「必要なロール」のメタデータを付与し、
// RoleGuard が SessionAuthGuard によって request.user にセットされた roles と比較する。
export const ROLES_KEY = 'roles';

export const Roles = (...roles: RoleName[]) => SetMetadata(ROLES_KEY, roles);
