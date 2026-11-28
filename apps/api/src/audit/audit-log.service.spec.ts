// PBI6 セキュリティレビュー対応の単体テスト（AuditLogService.record）。
// - 要修正-2：Prisma・DBの例外を、機微情報の無い例外に包み直す（メッセージ・ログに入力値が出ない）。
// - 軽微-1：before/after のキーが、対象の種類のホワイトリストに含まれることを確認する。
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditAction, AuditTargetType } from '@expense/shared';
import { AuditLogService, AuditRecordError } from './audit-log.service';

const SECRET_EMAIL = 'secret-person@example.com';
const SECRET_TEXT = '機微な自由入力-XYZZY';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const EXPENSE_ID = '33333333-3333-4333-8333-333333333333';

describe('AuditLogService.record', () => {
  let service: AuditLogService;
  let create: jest.Mock;
  let tx: Prisma.TransactionClient;
  let loggerError: jest.SpyInstance;

  beforeEach(() => {
    service = new AuditLogService();
    create = jest.fn().mockResolvedValue({});
    tx = { auditLog: { create } } as unknown as Prisma.TransactionClient;
    loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('要修正-2: 例外の包み直し', () => {
    it('Prismaの例外（メッセージに入力値を含む）は、機微情報の無いAuditRecordErrorになる', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError(
        `Invalid \`tx.auditLog.create()\` invocation: actorEmail: "${SECRET_EMAIL}" ${SECRET_TEXT}`,
        { code: 'P2002', clientVersion: 'test' },
      );
      create.mockRejectedValue(prismaError);

      const error = await service
        .record(tx, {
          action: AuditAction.LOGIN,
          targetType: AuditTargetType.USER,
          actorEmail: SECRET_EMAIL,
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuditRecordError);
      const e = error as AuditRecordError;
      expect(e.message).toBe(
        'audit record failed (PrismaClientKnownRequestError P2002)',
      );
      expect(e.message).not.toContain(SECRET_EMAIL);
      expect(e.message).not.toContain(SECRET_TEXT);
      // 元の例外を引き継がない（cause経由でログに出ない）。
      expect((e as { cause?: unknown }).cause).toBeUndefined();
      expect(e.stack).not.toContain(SECRET_EMAIL);
      expect(e.stack).not.toContain(SECRET_TEXT);
    });

    it('素のErrorのDB障害も包み直す（メッセージを引き継がない）', async () => {
      create.mockRejectedValue(new Error(`db down ${SECRET_EMAIL}`));

      await expect(
        service.record(tx, {
          action: AuditAction.LOGOUT,
          targetType: AuditTargetType.SESSION,
        }),
      ).rejects.toThrow('audit record failed (Error)');
    });

    it('コードに見えない値（入力値が入り得る文字列）はメッセージに出さない', async () => {
      const err = Object.assign(new Error('x'), { code: SECRET_EMAIL });
      create.mockRejectedValue(err);

      await expect(
        service.record(tx, {
          action: AuditAction.LOGOUT,
          targetType: AuditTargetType.SESSION,
        }),
      ).rejects.toThrow(/^audit record failed \(Error\)$/);
    });

    it('記録失敗時のアプリログに、メール・自由入力が出ない', async () => {
      create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError(
          `bad data ${SECRET_EMAIL} ${SECRET_TEXT}`,
          { code: 'P2000', clientVersion: 'test' },
        ),
      );

      await service
        .record(tx, {
          action: AuditAction.LOGIN,
          targetType: AuditTargetType.USER,
          actorEmail: SECRET_EMAIL,
        })
        .catch(() => undefined);

      const logged = JSON.stringify(loggerError.mock.calls);
      expect(logged).toContain('audit record failed');
      expect(logged).not.toContain(SECRET_EMAIL);
      expect(logged).not.toContain(SECRET_TEXT);
    });

    it('自前の検証エラー（長すぎるメール）もAuditRecordErrorで、値を含まない', async () => {
      const longEmail = `${'a'.repeat(260)}@example.com`;
      const error = await service
        .record(tx, {
          action: AuditAction.LOGIN,
          targetType: AuditTargetType.USER,
          actorEmail: longEmail,
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuditRecordError);
      expect((error as Error).message).toBe('audit actorEmail is too long');
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('軽微-1: スナップショットのキー検証', () => {
    const expenseSnapshot = {
      status: 'DRAFT',
      expenseDate: '2026-11-20',
      amount: 1500,
      category: 'TRANSPORTATION',
      description: SECRET_TEXT,
      approverId: null,
      returnReason: null,
    };

    it('申請：ホワイトリストのキーだけなら記録できる', async () => {
      await service.record(tx, {
        actorUserId: USER_ID,
        action: AuditAction.EXPENSE_CREATE,
        targetType: AuditTargetType.EXPENSE_REQUEST,
        targetId: EXPENSE_ID,
        before: null,
        after: expenseSnapshot as never,
      });
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('申請：ホワイトリストに無いキー（禁止パターンに当たらない名前）は拒否する', async () => {
      const error = await service
        .record(tx, {
          action: AuditAction.EXPENSE_UPDATE,
          targetType: AuditTargetType.EXPENSE_REQUEST,
          targetId: EXPENSE_ID,
          before: null,
          after: { ...expenseSnapshot, note: 'xxx' } as never,
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuditRecordError);
      expect((error as Error).message).toBe(
        'audit snapshot contains a key not allowed',
      );
      expect((error as Error).message).not.toContain('note');
      expect(create).not.toHaveBeenCalled();
    });

    it('before側のホワイトリスト外のキーも拒否する', async () => {
      await expect(
        service.record(tx, {
          action: AuditAction.EXPENSE_DELETE,
          targetType: AuditTargetType.EXPENSE_REQUEST,
          targetId: EXPENSE_ID,
          before: { ...expenseSnapshot, applicantId: USER_ID } as never,
          after: null,
        }),
      ).rejects.toThrow(AuditRecordError);
      expect(create).not.toHaveBeenCalled();
    });

    it('ロール付与・剥奪（targetType=USER）はUSER_ROLEの項目で検証する', async () => {
      const roleSnap = (granted: boolean) => ({
        roleId: 'role-1',
        roleName: 'MANAGER',
        granted,
      });
      await service.record(tx, {
        actorUserId: USER_ID,
        action: AuditAction.ROLE_GRANT,
        targetType: AuditTargetType.USER,
        targetId: USER_ID,
        before: roleSnap(false) as never,
        after: roleSnap(true) as never,
      });
      expect(create).toHaveBeenCalledTimes(1);

      await expect(
        service.record(tx, {
          action: AuditAction.ROLE_REVOKE,
          targetType: AuditTargetType.USER,
          targetId: USER_ID,
          before: { ...roleSnap(true), extra: 1 } as never,
          after: roleSnap(false) as never,
        }),
      ).rejects.toThrow(AuditRecordError);
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('ロール変更以外のUSER（ログイン等）は項目が空なので、何かを載せると拒否する', async () => {
      await expect(
        service.record(tx, {
          action: AuditAction.LOGIN,
          targetType: AuditTargetType.USER,
          targetId: USER_ID,
          after: { roleId: 'role-1' } as never,
        }),
      ).rejects.toThrow(AuditRecordError);
      expect(create).not.toHaveBeenCalled();
    });

    it('before・afterがnull／省略のときは記録できる', async () => {
      await service.record(tx, {
        action: AuditAction.LOGOUT,
        targetType: AuditTargetType.SESSION,
        targetId: USER_ID,
      });
      expect(create).toHaveBeenCalledTimes(1);
    });
  });
});
