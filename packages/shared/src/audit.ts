// 監査ログ（PBI6）関連の定数・型。設計の詳細は docs/api/pbi-6.md を参照。
//
// 方針：
// - 記録は Service 層が業務更新と同じトランザクション内で行う（Interceptorでは行わない）。
// - 変更前後の値（before/after）は「ホワイトリスト」方式。対象の種類ごとに載せてよい
//   項目を AUDIT_SNAPSHOT_FIELDS で固定し、そこに無い項目は絶対に載せない。
//   パスワード・passwordHash・Cookie・セッショントークン（tokenHash含む）は
//   ホワイトリストに存在しないため、構造的に混入しない。
// - 旧 RoleChangeAuditPayload（PBI2で先行定義、未使用）は、ロール変更も他の操作と同じ
//   AuditLogDto の形（targetType=USER、before/after に付与されたロール1件の差分）で
//   扱うことにしたため削除した。

import type { ExpenseCategory, ExpenseStatus } from './expenses';
import type { RoleName } from './roles';

// 何をしたか（操作の種類）。DBの audit_logs.action にこの値をそのまま保存する。
// RECEIPT_* は PBI5（領収書）で使う。値だけ先に定義しておく（PBI5の実装時に記録する）。
export const AuditAction = {
  LOGIN: 'LOGIN', // ログイン（成功・失敗の両方。結果は result で区別する）
  LOGOUT: 'LOGOUT', // ログアウト
  ROLE_GRANT: 'ROLE_GRANT', // ロール付与
  ROLE_REVOKE: 'ROLE_REVOKE', // ロール剥奪
  EXPENSE_CREATE: 'EXPENSE_CREATE', // 申請の作成（下書き）
  EXPENSE_UPDATE: 'EXPENSE_UPDATE', // 申請の編集
  EXPENSE_DELETE: 'EXPENSE_DELETE', // 申請の削除（下書きのみ）
  EXPENSE_SUBMIT: 'EXPENSE_SUBMIT', // 申請の提出（再提出を含む）
  EXPENSE_APPROVE: 'EXPENSE_APPROVE', // 承認
  EXPENSE_RETURN: 'EXPENSE_RETURN', // 差し戻し
  RECEIPT_UPLOAD: 'RECEIPT_UPLOAD', // 領収書アップロード（PBI5）
  RECEIPT_URL_ISSUE: 'RECEIPT_URL_ISSUE', // 領収書の閲覧URL発行（PBI5）
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export const ALL_AUDIT_ACTIONS: AuditAction[] = Object.values(AuditAction);

// 結果（成功・失敗）。
export const AuditResult = {
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
} as const;

export type AuditResult = (typeof AuditResult)[keyof typeof AuditResult];

export const ALL_AUDIT_RESULTS: AuditResult[] = Object.values(AuditResult);

// 何に（対象の種類）。
// - ログイン・ロール変更 → USER（ログイン／ロール変更を受けたユーザー）
// - ログアウト → SESSION（Session.id。Cookieに載る生トークンやtokenHashではない）
// - 申請系 → EXPENSE_REQUEST
// - 領収書系 → RECEIPT（PBI5。領収書IDを targetId にする）
export const AuditTargetType = {
  USER: 'USER',
  SESSION: 'SESSION',
  EXPENSE_REQUEST: 'EXPENSE_REQUEST',
  RECEIPT: 'RECEIPT',
} as const;

export type AuditTargetType =
  (typeof AuditTargetType)[keyof typeof AuditTargetType];

export const ALL_AUDIT_TARGET_TYPES: AuditTargetType[] = Object.values(AuditTargetType);

// 失敗（result=FAILURE）の理由コード。監査ログの閲覧は管理者だけなので、
// クライアントに返すエラーでは統一している理由（AUTH_INVALID_CREDENTIALS）も、
// ここでは区別して残す（不正アクセスの調査に必要なため）。
// 閲覧APIの利用者（ADMIN）以外には絶対に返さないこと。
export const AuditFailureCode = {
  LOGIN_UNKNOWN_EMAIL: 'LOGIN_UNKNOWN_EMAIL', // 存在しないメールアドレス
  LOGIN_BAD_PASSWORD: 'LOGIN_BAD_PASSWORD', // パスワード違い
  LOGIN_INACTIVE_USER: 'LOGIN_INACTIVE_USER', // 無効化済みユーザー
  LOGIN_LOCKED: 'LOGIN_LOCKED', // ロックアウト中
} as const;

export type AuditFailureCode =
  (typeof AuditFailureCode)[keyof typeof AuditFailureCode];

// ------------------------------------------------------------
// 変更前後の値（スナップショット）
// ------------------------------------------------------------

// 対象の種類ごとに「変更前後の値に載せてよい項目」を固定するホワイトリスト。
// 実装（apps/api の AuditLogService）は、この一覧に載っている項目だけをコピーして
// before/after を作る（オブジェクトをそのまま渡して余分な項目を削る、のではなく、
// 載せる項目を選んで取り出す）。新しい項目を載せたいときは、ここに足すこと自体を
// レビュー対象にする。
// 載せてはいけないもの：password / passwordHash / Cookie / セッショントークン
// （tokenHash含む）/ 秘密情報全般。これらは次の AUDIT_FORBIDDEN_KEY_PATTERN でも
// 二重に弾く。
export const AUDIT_SNAPSHOT_FIELDS = {
  EXPENSE_REQUEST: [
    'status',
    'expenseDate',
    'amount',
    'category',
    'description',
    'approverId',
    'returnReason',
  ],
  // ロール付与・剥奪は「付与・剥奪された1ロール」の差分だけを残す。
  // （ユーザーの全ロール一覧を前後で残すと、同時操作時に前後の値が正確でなくなる。
  //  付与＝行が作られた／剥奪＝行が消えた、という事実だけを記録すれば常に正確。）
  USER_ROLE: ['roleId', 'roleName', 'granted'],
  // ログイン・ログアウトは変更前後の値を持たない（before/after は null）。
  USER: [],
  SESSION: [],
  RECEIPT: [],
} as const;

// before/after のキー名にこのパターンが含まれていたら、記録処理を失敗させる
// （＝業務の更新もロールバックされる）。ホワイトリストが正しく働いていれば発火しない、
// 実装ミスを検出するための二重の防御。大文字小文字は区別しない。
export const AUDIT_FORBIDDEN_KEY_PATTERN = /pass(word)?|hash|token|cookie|secret|session/i;

// スナップショット1項目の値。フラットなJSON（ネストなし）に限定する。
export type AuditSnapshotValue = string | number | boolean | null;

export type AuditSnapshot = Record<string, AuditSnapshotValue>;

// 申請のスナップショット（EXPENSE_REQUEST）。日付は "YYYY-MM-DD"。
export interface ExpenseAuditSnapshot extends AuditSnapshot {
  status: ExpenseStatus;
  expenseDate: string;
  amount: number;
  category: ExpenseCategory;
  description: string;
  approverId: string | null;
  returnReason: string | null;
}

// ロール付与・剥奪のスナップショット（ROLE_GRANT / ROLE_REVOKE）。
// 付与：before = { ..., granted: false }, after = { ..., granted: true }
// 剥奪：before = { ..., granted: true },  after = { ..., granted: false }
export interface UserRoleAuditSnapshot extends AuditSnapshot {
  roleId: string;
  roleName: RoleName;
  granted: boolean;
}

// before/after の JSON のサイズ上限（バイト）。異常に大きい値でテーブルが膨らむのを防ぐ。
export const AUDIT_SNAPSHOT_MAX_BYTES = 8192;

// ------------------------------------------------------------
// 保存する項目の長さ上限
// ------------------------------------------------------------

// ログイン失敗時に残す入力メールアドレスの最大文字数（RFC 5321の254に合わせる）。
export const AUDIT_ACTOR_EMAIL_MAX_LENGTH = 254;
// IPv6（IPv4射影形式を含む）の最大文字数は45。
export const AUDIT_IP_ADDRESS_MAX_LENGTH = 45;

// ------------------------------------------------------------
// 閲覧API（GET /admin/audit-logs）
// ------------------------------------------------------------

// 1ページの件数（固定。クライアントからは変更できない。pageSize をクエリに付けると400）。
export const AUDIT_LOG_PAGE_SIZE = 50;
// page の上限（深いOFFSETによる負荷対策。10000ページ＝50万件）。
export const AUDIT_LOG_MAX_PAGE = 10000;

// 監査ログ1件分のレスポンス型。
export interface AuditLogDto {
  id: string;
  occurredAt: string; // ISO8601（UTC）。いつ
  // 誰が。ログイン失敗など未認証の操作は null（その場合 actorEmail に入力値が入る）。
  actorUserId: string | null;
  // ログイン失敗時に入力されたメールアドレス。それ以外は null。
  actorEmail: string | null;
  action: AuditAction; // 何を
  result: AuditResult; // 成功・失敗
  failureCode: AuditFailureCode | null; // result=FAILURE のときの理由
  targetType: AuditTargetType; // 何に（種類）
  // 何に（ID）。存在しないメールアドレスでのログイン失敗など、対象が特定できない場合は null。
  targetId: string | null;
  before: AuditSnapshot | null; // 変更前の値（新規作成・状態を変えない操作は null）
  after: AuditSnapshot | null; // 変更後の値（削除・状態を変えない操作は null）
  ipAddress: string | null;
}

// GET /admin/audit-logs のクエリ（プレーンなTS型）。すべて任意。
// class-validator付きDTOクラスは apps/api 側で別途定義する。
// pageSize は受け付けない（固定50件。forbidNonWhitelisted により付けると400）。
export interface AuditLogListQuery {
  page?: number; // 1始まり。省略時1。1〜AUDIT_LOG_MAX_PAGE
  actorUserId?: string; // 操作者（UUID）で絞り込み
  // ログイン失敗時に入力されたメールアドレスで絞り込み（完全一致。大文字小文字も区別する）。
  // 特定のメールアドレスへの攻撃の調査用。最大 AUDIT_ACTOR_EMAIL_MAX_LENGTH 文字、メール形式。
  actorEmail?: string;
  targetType?: AuditTargetType; // 対象の種類で絞り込み
  targetId?: string; // 対象ID（UUID）で絞り込み。targetType と併用する想定（単独でも可）
  from?: string; // 期間の開始（含む）。タイムゾーン付きISO8601（例: 2026-11-01T00:00:00+09:00）
  to?: string; // 期間の終了（含まない）。同上。from < to でなければ400
}

// GET /admin/audit-logs のレスポンス型（CLAUDE.md 横断ルール6）。
export interface AuditLogListResponseDto {
  items: AuditLogDto[];
  total: number; // 絞り込み条件に合う総件数
  page: number;
  pageSize: number; // 常に AUDIT_LOG_PAGE_SIZE
}
