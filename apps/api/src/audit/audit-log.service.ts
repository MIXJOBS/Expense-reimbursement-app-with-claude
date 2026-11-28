import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AUDIT_ACTOR_EMAIL_MAX_LENGTH,
  AUDIT_FORBIDDEN_KEY_PATTERN,
  AUDIT_IP_ADDRESS_MAX_LENGTH,
  AUDIT_SNAPSHOT_FIELDS,
  AUDIT_SNAPSHOT_MAX_BYTES,
  AuditResult,
  type AuditAction,
  type AuditFailureCode,
  type AuditSnapshot,
  type AuditTargetType,
  type ExpenseAuditSnapshot,
  type ExpenseCategory,
  type ExpenseStatus,
  type RoleName,
  type UserRoleAuditSnapshot,
} from '@expense/shared';

// 記録する1件分の入力。サーバーが決める値だけを受け取る
// （クライアントのリクエストボディをそのまま渡す経路は作らない）。
export interface AuditRecordInput {
  actorUserId?: string | null;
  // ログイン失敗時の入力メールアドレスだけ（LoginDtoの@IsEmail()を通った値）。
  actorEmail?: string | null;
  action: AuditAction;
  result?: AuditResult; // 省略時 SUCCESS
  failureCode?: AuditFailureCode | null;
  targetType: AuditTargetType;
  targetId?: string | null;
  before?: AuditSnapshot | null;
  after?: AuditSnapshot | null;
  ipAddress?: string | null;
}

// 記録失敗を表す例外。メッセージは固定文言（＋エラー種別）だけで、Prismaの例外メッセージ
// （呼び出し箇所のコードや data の値＝入力メール・申請の自由入力を含み得る）は持たない。
// 元の例外（cause）も保持しない（ログ出力時にcause経由で漏れるのを防ぐ）。
export class AuditRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditRecordError';
  }
}

// before/after に載せてよいキーの集合。targetType では USER_ROLE を区別できない
// （ロール変更は targetType=USER）ため、ロール変更の action だけ USER_ROLE を使う。
function allowedSnapshotKeys(
  action: AuditAction,
  targetType: AuditTargetType,
): readonly string[] {
  if (action === 'ROLE_GRANT' || action === 'ROLE_REVOKE') {
    return AUDIT_SNAPSHOT_FIELDS.USER_ROLE;
  }
  return AUDIT_SNAPSHOT_FIELDS[targetType];
}

// 申請の行から、ホワイトリスト項目だけを取り出すための最小の型。
// User行のような機微情報を持つ行は、この型に当てはまらない。
export interface ExpenseSnapshotSource {
  status: string;
  expenseDate: Date;
  amount: number;
  category: string;
  description: string;
  approverId: string | null;
  returnReason: string | null;
}

/**
 * 監査ログの記録（PBI6）。docs/api/pbi-6.md
 *
 * - 記録は必ず業務更新と同じトランザクション（tx）で行う。tx を渡さない口は作らない。
 * - 記録に失敗（禁止キー・サイズ超過・DB障害）したら例外を投げる＝呼び出し元のTx全体が
 *   ロールバックされ、業務の更新も反映されない。
 * - このテーブルへの作成は record 内の create 1箇所だけ（追記専用）。
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  async record(
    tx: Prisma.TransactionClient,
    entry: AuditRecordInput,
  ): Promise<void> {
    try {
      const allowedKeys = allowedSnapshotKeys(entry.action, entry.targetType);
      const before = this.checkSnapshot(entry.before, allowedKeys);
      const after = this.checkSnapshot(entry.after, allowedKeys);
      this.checkLength(
        entry.actorEmail,
        AUDIT_ACTOR_EMAIL_MAX_LENGTH,
        'actorEmail',
      );
      this.checkLength(
        entry.ipAddress,
        AUDIT_IP_ADDRESS_MAX_LENGTH,
        'ipAddress',
      );

      await tx.auditLog.create({
        data: {
          actorUserId: entry.actorUserId ?? null,
          actorEmail: entry.actorEmail ?? null,
          action: entry.action,
          result: entry.result ?? AuditResult.SUCCESS,
          failureCode: entry.failureCode ?? null,
          targetType: entry.targetType,
          targetId: entry.targetId ?? null,
          before: before ?? Prisma.DbNull,
          after: after ?? Prisma.DbNull,
          ipAddress: entry.ipAddress ?? null,
        },
      });
    } catch (error) {
      // 横断ルール5：before/after・メールアドレスはログに出さない。
      // 出すのは action・targetType・targetId・エラー種別だけ。
      this.logger.error(
        `audit record failed: action=${entry.action} targetType=${entry.targetType} targetId=${entry.targetId ?? 'null'} error=${error instanceof Error ? error.name : 'unknown'}`,
      );
      // 自前の検証エラー（固定文言）はそのまま投げる。Prisma・DBの例外は、メッセージに
      // data の値（入力メール・申請の自由入力）を含み得るため、機微情報の無い例外に
      // 包み直す。呼び出し元のTxはロールバックされ、500になる。
      if (error instanceof AuditRecordError) {
        throw error;
      }
      throw new AuditRecordError(
        `audit record failed (${error instanceof Error ? error.name : 'unknown'}${safeErrorCode(error)})`,
      );
    }
  }

  // ---------- スナップショット（ホワイトリスト方式） ----------

  /** 申請の変更前後の値。AUDIT_SNAPSHOT_FIELDS.EXPENSE_REQUEST の項目だけを選んで取り出す。 */
  expenseSnapshot(row: ExpenseSnapshotSource): ExpenseAuditSnapshot {
    const snapshot: ExpenseAuditSnapshot = {
      status: row.status as ExpenseStatus,
      expenseDate: row.expenseDate.toISOString().slice(0, 10),
      amount: row.amount,
      category: row.category as ExpenseCategory,
      description: row.description,
      approverId: row.approverId,
      returnReason: row.returnReason,
    };
    return snapshot;
  }

  /** ロール付与・剥奪の差分（1ロール分）。 */
  userRoleSnapshot(
    roleId: string,
    roleName: RoleName,
    granted: boolean,
  ): UserRoleAuditSnapshot {
    return { roleId, roleName, granted };
  }

  // ---------- 検証 ----------

  private checkSnapshot(
    snapshot: AuditSnapshot | null | undefined,
    allowedKeys: readonly string[],
  ): Prisma.InputJsonObject | null {
    if (snapshot === null || snapshot === undefined) {
      return null;
    }
    for (const [key, value] of Object.entries(snapshot)) {
      // 対象の種類ごとのホワイトリストに無いキーは載せない（キー名はメッセージに出さない）。
      if (!allowedKeys.includes(key)) {
        throw new AuditRecordError('audit snapshot contains a key not allowed');
      }
      // ホワイトリストが正しければ発火しない、実装ミス検出用の二重の防御。
      if (AUDIT_FORBIDDEN_KEY_PATTERN.test(key)) {
        throw new AuditRecordError('audit snapshot contains a forbidden key');
      }
      if (value !== null && typeof value === 'object') {
        throw new AuditRecordError('audit snapshot must be flat');
      }
    }
    if (
      Buffer.byteLength(JSON.stringify(snapshot)) > AUDIT_SNAPSHOT_MAX_BYTES
    ) {
      throw new AuditRecordError('audit snapshot is too large');
    }
    return snapshot as Prisma.InputJsonObject;
  }

  private checkLength(
    value: string | null | undefined,
    max: number,
    name: string,
  ): void {
    if (value !== null && value !== undefined && value.length > max) {
      throw new AuditRecordError(`audit ${name} is too long`);
    }
  }
}

// Prisma・pgのエラーコード（P2002 等）だけを取り出す。コードに見えない値は出さない。
function safeErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(code)
    ? ` ${code}`
    : '';
}

// ホワイトリストの項目一覧と実装の取り出し項目がずれていないことを、
// 起動時（import時）に確認する。ずれていたら起動できない（実装ミスを早く検出する）。
const EXPENSE_KEYS = [
  'status',
  'expenseDate',
  'amount',
  'category',
  'description',
  'approverId',
  'returnReason',
] as const;
if (
  [...EXPENSE_KEYS].sort().join(',') !==
  [...AUDIT_SNAPSHOT_FIELDS.EXPENSE_REQUEST].sort().join(',')
) {
  throw new Error(
    'AuditLogService.expenseSnapshot is out of sync with AUDIT_SNAPSHOT_FIELDS',
  );
}
