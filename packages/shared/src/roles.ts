// ロール名の定数・型。
// DB（Role.name）にもこの値がそのまま格納される想定。
// 1アカウントに複数のロールを持てる（CLAUDE.md参照）。社員は全員APPLICANTを持ち、
// 上長・経理・管理者は追加でMANAGER/ACCOUNTING/ADMINを持つ。

export const RoleName = {
  APPLICANT: 'APPLICANT', // 申請者（全社員が持つ基本ロール）
  MANAGER: 'MANAGER', // 上長（承認）
  ACCOUNTING: 'ACCOUNTING', // 経理（経理確認）
  ADMIN: 'ADMIN', // 管理者（ロール付与・剥奪等）
} as const;

export type RoleName = (typeof RoleName)[keyof typeof RoleName];

export const ALL_ROLE_NAMES: RoleName[] = Object.values(RoleName);
