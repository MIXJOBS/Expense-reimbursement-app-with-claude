// PBI2（ロールと権限）: 「最後のADMIN剥奪防止」の単体テスト。
//
// 前提：RolesService（apps/api/src/admin/roles.service.ts）はまだ実装されていない。
// このテストは実装前提のクラス・メソッドをimportするため、importエラー等で
// 確実に失敗する（これも想定どおりのred）。
//
// 設計メモ（docs/api/pbi-1-2.md, prisma/schema.prisma のUserRoleコメント参照）：
// - RolesService.revokeRole(actorUserId, targetUserId, roleId) がロール剥奪のエントリポイント。
// - 自分自身チェック（FORBIDDEN_SELF_ROLE_CHANGE）が先に評価され、その後
//   「剥奪後にADMIN保持者（isActive=trueのユーザーのみ）が0人になるかどうか」を
//   悲観ロック（$transaction + $queryRaw の SELECT ... FOR UPDATE 相当）で確認し、
//   0人になる場合は FORBIDDEN_LAST_ADMIN を投げる。
// - 単体テストでは同時実行そのものではなく、「剥奪した結果ADMINが0人になる」状態を
//   直接用意し、その1回の呼び出しが拒否されることを確認する
//   （同時実行による競合のe2eでの検証は test/admin-roles.e2e-spec.ts 側で行う）。
//
// 担当範囲: *.spec.ts / e2e のみ。実装コード（RolesService本体等）は書かない。
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { RolesService } from './roles.service';
import { PrismaService } from '../prisma/prisma.service';
import { ErrorCode, RoleName } from '@expense/shared';

describe('RolesService', () => {
  let service: RolesService;
  let prisma: {
    user: { findUnique: jest.Mock };
    role: { findUnique: jest.Mock };
    userRole: {
      findUnique: jest.Mock;
      delete: jest.Mock;
      count: jest.Mock;
    };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };

  const actorUserId = 'actor-admin-uuid';
  const targetUserId = 'target-admin-uuid';
  const adminRoleId = 'admin-role-uuid';

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn() },
      role: { findUnique: jest.fn() },
      userRole: {
        findUnique: jest.fn(),
        delete: jest.fn(),
        count: jest.fn(),
      },
      // RolesService が「剥奪後にADMINが0人になるかどうか」の確認と
      // 実際のDELETEを同一トランザクション内で行う想定のため、
      // $transaction はコールバックをそのまま実行するモックにしておく。
      $transaction: jest.fn(async (cb: any) => cb(prisma)),
      $queryRaw: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        RolesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = moduleRef.get(RolesService);
  });

  describe('revokeRole - 最後のADMIN剥奪防止 (FORBIDDEN_LAST_ADMIN)', () => {
    it('剥奪を実行すると管理者(isActive=trueでADMINを持つユーザー)が0人になる場合は拒否する', async () => {
      // 対象者自身はADMINロールを持っており、剥奪対象の付与関係も存在する前提。
      prisma.userRole.findUnique.mockResolvedValue({
        id: 'user-role-row-uuid',
        userId: targetUserId,
        roleId: adminRoleId,
      });
      prisma.role.findUnique.mockResolvedValue({
        id: adminRoleId,
        name: RoleName.ADMIN,
      });
      prisma.user.findUnique.mockResolvedValue({
        id: targetUserId,
        isActive: true,
      });

      // 悲観ロック下で数えた結果、このUserRoleを剥奪すると
      // isActive=trueのADMIN保持者が0人になる（＝現在ちょうど1人で、それが剥奪対象本人）。
      prisma.$queryRaw.mockResolvedValue([
        { userId: targetUserId, isActive: true },
      ]);

      await expect(
        service.revokeRole(actorUserId, targetUserId, adminRoleId),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: ErrorCode.FORBIDDEN_LAST_ADMIN,
        }),
      });

      // 最後の管理者保護に引っかかった場合、実際のDELETEは実行されてはならない。
      expect(prisma.userRole.delete).not.toHaveBeenCalled();
    });

    it('拒否時はForbiddenException（403相当）として例外を投げる', async () => {
      prisma.userRole.findUnique.mockResolvedValue({
        id: 'user-role-row-uuid',
        userId: targetUserId,
        roleId: adminRoleId,
      });
      prisma.role.findUnique.mockResolvedValue({
        id: adminRoleId,
        name: RoleName.ADMIN,
      });
      prisma.user.findUnique.mockResolvedValue({
        id: targetUserId,
        isActive: true,
      });
      prisma.$queryRaw.mockResolvedValue([
        { userId: targetUserId, isActive: true },
      ]);

      await expect(
        service.revokeRole(actorUserId, targetUserId, adminRoleId),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('revokeRole - 自分自身のロール変更は不可 (FORBIDDEN_SELF_ROLE_CHANGE)', () => {
    it('actorUserIdとtargetUserIdが同一の場合、最後の管理者チェックより先に拒否する', async () => {
      await expect(
        service.revokeRole(actorUserId, actorUserId, adminRoleId),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: ErrorCode.FORBIDDEN_SELF_ROLE_CHANGE,
        }),
      });

      // 自分自身チェックが先に評価されるため、最後の管理者チェック用のクエリには
      // 到達しないはず（docs/api/pbi-1-2.md: 「自分自身チェックが先に評価される」）。
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });
});
