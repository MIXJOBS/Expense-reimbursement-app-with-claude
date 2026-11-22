import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ErrorCode,
  RoleName,
  type AdminRoleListItemDto,
  type AdminUserListItemDto,
} from '@expense/shared';
import { PrismaService } from '../prisma/prisma.service';
import { getRoleNamesForUser } from '../auth/user-roles.util';

// GET /admin/users はページネーションを実装しないが、サーバー側で最大100件の
// ハードリミットを設ける（docs/api/pbi-1-2.md。クライアントに公開するパラメータではない）。
const MAX_USER_LIST_LIMIT = 100;

// 悲観ロックで数える「isActive=trueのADMIN保持者」の行の型（$queryRawの結果）。
interface ActiveAdminRow {
  userId: string;
  isActive: boolean;
}

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 指定ユーザーにロールを付与する。
   * 評価順序（docs/api/pbi-1-2.md）: 自分自身チェック → 対象ユーザー/ロールの存在確認。
   */
  async grantRole(
    actorUserId: string,
    targetUserId: string,
    roleId: string,
  ): Promise<void> {
    this.assertNotSelf(actorUserId, targetUserId);

    const [targetUser, role] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: targetUserId } }),
      this.prisma.role.findUnique({ where: { id: roleId } }),
    ]);

    if (!targetUser) {
      throw this.notFound();
    }
    if (!role) {
      throw this.notFound();
    }

    await this.prisma.userRole.upsert({
      where: { userId_roleId: { userId: targetUserId, roleId } },
      update: {},
      create: {
        userId: targetUserId,
        roleId,
        grantedById: actorUserId,
      },
    });
  }

  /**
   * 指定ユーザーからロールを剥奪する。
   *
   * 評価順序（docs/api/pbi-1-2.md、roles.service.spec.ts）:
   * 1. 自分自身チェック（FORBIDDEN_SELF_ROLE_CHANGE）。$queryRawには到達しない。
   * 2. 対象ユーザー・ロール・付与関係(UserRole)の存在確認（404 NOT_FOUND）。
   * 3. 剥奪対象がADMINロールの場合のみ、悲観ロック（$transaction + $queryRaw の
   *    SELECT ... FOR UPDATE 相当）で、剥奪後にisActive=trueのADMIN保持者が
   *    0人になるかどうかを確認し、0人になる場合はFORBIDDEN_LAST_ADMINで拒否する。
   */
  async revokeRole(
    actorUserId: string,
    targetUserId: string,
    roleId: string,
  ): Promise<void> {
    this.assertNotSelf(actorUserId, targetUserId);

    const userRole = await this.prisma.userRole.findUnique({
      where: { userId_roleId: { userId: targetUserId, roleId } },
    });
    if (!userRole) {
      throw this.notFound();
    }

    const [targetUser, role] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: targetUserId } }),
      this.prisma.role.findUnique({ where: { id: roleId } }),
    ]);
    if (!targetUser) {
      throw this.notFound();
    }
    if (!role) {
      throw this.notFound();
    }

    await this.prisma.$transaction(async (tx) => {
      if (role.name === RoleName.ADMIN) {
        // 悲観ロック：ADMINロールを持つ UserRole 行集合に対して
        // SELECT ... FOR UPDATE 相当の行ロックをかけた上で、
        // isActive=trueのユーザーに限定して保持者を数える。
        const lockedAdminRows = await tx.$queryRaw<ActiveAdminRow[]>(
          Prisma.sql`
            SELECT u.id AS "userId", u."isActive" AS "isActive"
            FROM "user_roles" ur
            INNER JOIN "users" u ON u.id = ur."userId"
            WHERE ur."roleId" = ${roleId}::uuid
            FOR UPDATE OF ur, u
          `,
        );

        const activeAdminUserIds = new Set(
          lockedAdminRows
            .filter((row) => row.isActive)
            .map((row) => row.userId),
        );

        const remainingActiveAdminCount = Array.from(activeAdminUserIds).filter(
          (userId) => userId !== targetUserId,
        ).length;

        if (remainingActiveAdminCount === 0) {
          throw new ForbiddenException({
            code: ErrorCode.FORBIDDEN_LAST_ADMIN,
            message: '最後の管理者からADMINロールを剥奪することはできません。',
          });
        }
      }

      await tx.userRole.delete({ where: { id: userRole.id } });
    });
  }

  /**
   * 指定ユーザーのロール一覧（GET /admin/users/:userId/roles）。
   */
  async listUserRoles(targetUserId: string): Promise<AdminRoleListItemDto[]> {
    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });
    if (!targetUser) {
      throw this.notFound();
    }

    const userRoles = await this.prisma.userRole.findMany({
      where: { userId: targetUserId },
      include: { role: true },
    });

    return userRoles.map((userRole) => ({
      id: userRole.role.id,
      name: userRole.role.name as RoleName,
    }));
  }

  /**
   * 付与可能なロール一覧（GET /admin/roles）。
   */
  async listRoles(): Promise<AdminRoleListItemDto[]> {
    const roles = await this.prisma.role.findMany({
      orderBy: { name: 'asc' },
    });
    return roles.map((role) => ({
      id: role.id,
      name: role.name as RoleName,
    }));
  }

  /**
   * 全ユーザー一覧（GET /admin/users）。
   * ページネーションは実装しないが、サーバー側で最大100件のハードリミットを設ける。
   */
  async listUsers(): Promise<AdminUserListItemDto[]> {
    const users = await this.prisma.user.findMany({
      take: MAX_USER_LIST_LIMIT,
      orderBy: { createdAt: 'asc' },
    });

    return Promise.all(
      users.map(async (user) => ({
        id: user.id,
        email: user.email,
        name: user.name,
        isActive: user.isActive,
        managerId: user.managerId,
        roles: await getRoleNamesForUser(this.prisma, user.id),
      })),
    );
  }

  private assertNotSelf(actorUserId: string, targetUserId: string): void {
    if (actorUserId === targetUserId) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN_SELF_ROLE_CHANGE,
        message: '自分自身のロールは変更できません。',
      });
    }
  }

  private notFound(): NotFoundException {
    return new NotFoundException({
      code: ErrorCode.NOT_FOUND,
      message: '対象が見つかりません。',
    });
  }
}
