// { code, message } 形式のエラーレスポンスで使うコード定数。
// 「パスワード違い」「存在しないユーザー」「無効化(isActive=false)されたユーザー」
// 「ロックアウト中」のログイン失敗は、すべて同一コード・同一メッセージにする。
// ロック中だけ専用のコード（AUTH_LOCKED等）やステータス（423/429等）を返すと、
// 「5回間違えたらロックされた＝このメールアドレスは存在する」という情報が
// 攻撃者に漏れてしまうため（存在しないメールアドレスはロックされない）、
// 専用のロック用エラーコードは設けない（常にAUTH_INVALID_CREDENTIALS）。

export const ErrorCode = {
  // 認証系
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS', // メール/パスワード誤り・存在しないユーザー・無効化済みユーザー・ロックアウト中のログイン試行、すべて同一コード
  AUTH_UNAUTHORIZED: 'AUTH_UNAUTHORIZED', // 未ログイン／セッション失効（絶対期限切れ・スライディング期限切れ・revoked共通）

  // 認可系
  FORBIDDEN: 'FORBIDDEN', // ロール不足
  FORBIDDEN_SELF_ROLE_CHANGE: 'FORBIDDEN_SELF_ROLE_CHANGE', // 自分自身のロールは変更不可
  FORBIDDEN_LAST_ADMIN: 'FORBIDDEN_LAST_ADMIN', // 最後のADMINロール保持者からADMINを剥奪しようとした

  // 汎用
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR', // 500。詳細はクライアントに返さない
  // IPアドレス単位のログイン試行レート制限（1分間に10回まで、11回目で429）。
  // 上記コメントの「ロック用の専用コードは設けない」は、メールアドレス単位の
  // アカウントロックアウト（5回失敗で15分ロック）の話であり、ユーザー列挙対策として
  // 常にAUTH_INVALID_CREDENTIALSを返す方針を指す。今回のIPアドレス単位のレート制限は、
  // 特定のメールアドレスの存在/不存在とは無関係（存在しないメールアドレスでも
  // 同一IPからの呼び出し回数だけで発生する）ため別軸であり、専用コードを設ける。
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// エラーレスポンス共通形
export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
}
