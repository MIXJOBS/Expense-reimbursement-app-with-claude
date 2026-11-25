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
      const before = this.checkSnapshot(entry.before);
      const after = this.checkSnapshot(entry.after);
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
      throw error;
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
  ): Prisma.InputJsonObject | null {
    if (snapshot === null || snapshot === undefined) {
      return null;
    }
    for (const [key, value] of Object.entries(snapshot)) {
      // ホワイトリストが正しければ発火しない、実装ミス検出用の二重の防御。
      if (AUDIT_FORBIDDEN_KEY_PATTERN.test(key)) {
        throw new Error('audit snapshot contains a forbidden key');
      }
      if (value !== null && typeof value === 'object') {
        throw new Error('audit snapshot must be flat');
      }
    }
    if (
      Buffer.byteLength(JSON.stringify(snapshot)) > AUDIT_SNAPSHOT_MAX_BYTES
    ) {
      throw new Error('audit snapshot is too large');
    }
    return snapshot as Prisma.InputJsonObject;
  }

  private checkLength(
    value: string | null | undefined,
    max: number,
    name: string,
  ): void {
    if (value !== null && value !== undefined && value.length > max) {
      throw new Error(`audit ${name} is too long`);
    }
  }
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
