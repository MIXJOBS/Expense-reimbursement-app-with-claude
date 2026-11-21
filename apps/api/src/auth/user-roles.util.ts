import { RoleName } from '@expense/shared';
import { PrismaService } from '../prisma/prisma.service';

// セッションにロールをキャッシュしない方針（docs/api/pbi-1-2.md）のため、
// リクエスト毎にDBから最新のUserRoleを取得してロール名配列にする共通処理。
export async function getRoleNamesForUser(
  prisma: PrismaService,
  userId: string,
): Promise<RoleName[]> {
  const userRoles = await prisma.userRole.findMany({
    where: { userId },
    include: { role: true },
  });
  return userRoles.map((userRole) => userRole.role.name as RoleName);
}
