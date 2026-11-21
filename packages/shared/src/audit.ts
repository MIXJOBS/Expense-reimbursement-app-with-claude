// 監査ログ記録（Interceptorでの実装自体はSprint3）に向けて、
// 「変更者・対象者・変更前後」を統一形式で渡せるようにしておくための型。
// ロール付与・剥奪のケースを想定した最小形。

export interface RoleChangeAuditPayload {
  actorUserId: string; // 変更者（管理者）
  targetUserId: string; // 対象ユーザー
  action: 'GRANT_ROLE' | 'REVOKE_ROLE';
  before: { roleIds: string[] }; // 変更前のロールID一覧
  after: { roleIds: string[] }; // 変更後のロールID一覧
  occurredAt: string; // ISO8601
}
