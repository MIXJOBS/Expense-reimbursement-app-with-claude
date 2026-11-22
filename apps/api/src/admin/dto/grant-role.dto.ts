import { IsUUID } from 'class-validator';
import type { GrantRoleRequestBody } from '@expense/shared';

// 横断ルール2: 入力検証はDTO + ValidationPipe（whitelist, forbidNonWhitelisted）で行う。
// packages/shared の GrantRoleRequestBody と構造を一致させる。
// IDはUUID（CLAUDE.md決定事項）のため @IsUUID() で検証する。
export class GrantRoleDto implements GrantRoleRequestBody {
  @IsUUID()
  roleId: string;
}
