// e2eテスト用の共通フィクスチャヘルパー。
//
// 実装（AuthService等）がまだ存在しないため、ログインAPIを経由せず
// PrismaService で User / Role / UserRole / Session を直接作成し、
// Session.tokenHash に対応する「生のトークン文字列」をCookieとして
// リクエストに付与することでログイン済み状態を再現する。
//
// 実装フェーズでハッシュ関数（SHA-256等）やCookie名が確定したら、
// このファイル内の定数・ハッシュ化方法を実装に合わせて調整すること
// （現時点ではドキュメント記載の「SHA-256等でハッシュ化」を仮採用）。
import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { RoleName } from '@expense/shared';

// 実装確定前の仮の値。AuthModule実装時にCookie名が確定したら合わせること。
export const SESSION_COOKIE_NAME = 'sid';

// CSRF対策で許可される想定のOrigin（apps/web の開発サーバ）。
// 実装確定前の仮の値。実装側の許可オリジン設定に合わせて調整すること。
export const ALLOWED_ORIGIN = 'http://localhost:5173';
export const DISALLOWED_ORIGIN = 'http://evil.example.com';

export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}@example.test`;
}

export interface CreatedUser {
  id: string;
  email: string;
}

/**
 * Role マスタ（APPLICANT/MANAGER/ACCOUNTING/ADMIN）は、テストの実行前に
 * `pretest:e2e`（`prisma migrate deploy && prisma db seed`、
 * apps/api/prisma/seed.ts）でテスト専用DBに投入される「共有の前提データ」。
 * テスト側でRoleをcreate/upsert/deleteする必要はない
 * （使い捨てロールを作ると、本物のADMINロールを参照しているかの検証に
 * ならないため。Role名から既存のRoleレコードを取得するだけに留める）。
 *
 * seedが実行されていない状態でテストを動かすと、ここで例外を投げて
 * 「seedを忘れている」ことが分かるようにする。
 */
export async function getRoleByName(
  prisma: PrismaClient,
  name: RoleName,
): Promise<{ id: string; name: string }> {
  const role = await prisma.role.findUnique({ where: { name } });
  if (!role) {
    throw new Error(
      `Role "${name}" がDBに存在しません。テスト実行前に seed（apps/api/prisma/seed.ts、` +
        `pretest:e2e経由）が実行されているか確認してください。`,
    );
  }
  return role;
}

export async function createUser(
  prisma: PrismaClient,
  params: {
    email: string;
    name?: string;
    isActive?: boolean;
    failedLoginCount?: number;
    lockedUntil?: Date | null;
    managerId?: string | null;
  },
): Promise<CreatedUser> {
  const user = await prisma.user.create({
    data: {
      email: params.email,
      name: params.name ?? params.email,
      // argon2での実ハッシュ化は不要（AuthServiceが無く検証ロジックも無いため）。
      passwordHash: 'placeholder-not-a-real-hash',
      isActive: params.isActive ?? true,
      failedLoginCount: params.failedLoginCount ?? 0,
      lockedUntil: params.lockedUntil ?? null,
      managerId: params.managerId ?? null,
    },
  });
  return { id: user.id, email: user.email };
}

export async function grantRole(
  prisma: PrismaClient,
  userId: string,
  roleId: string,
  grantedById: string | null = null,
): Promise<void> {
  await prisma.userRole.create({
    data: { userId, roleId, grantedById },
  });
}

/**
 * ログイン済み状態を再現するSessionを直接作成し、Cookieヘッダー文字列を返す。
 */
export async function createSessionCookie(
  prisma: PrismaClient,
  userId: string,
  opts?: { expiresAt?: Date; revokedAt?: Date | null; lastSeenAt?: Date },
): Promise<{ cookieHeader: string; sessionId: string; rawToken: string }> {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const session = await prisma.session.create({
    data: {
      tokenHash: hashToken(rawToken),
      userId,
      expiresAt: opts?.expiresAt ?? new Date(Date.now() + 8 * 60 * 60 * 1000),
      revokedAt: opts?.revokedAt ?? null,
      lastSeenAt: opts?.lastSeenAt ?? new Date(),
    },
  });
  return {
    cookieHeader: `${SESSION_COOKIE_NAME}=${rawToken}`,
    sessionId: session.id,
    rawToken,
  };
}

/**
 * 現在 isActive=true かつ指定ロールを保持しているユーザーのID一覧を返す。
 * 「最後の管理者保護」テストで、シード管理者等の既存ADMIN保持者を
 * 一時的に除外する際に使う。
 */
export async function findActiveUserIdsWithRole(
  prisma: PrismaClient,
  roleId: string,
): Promise<string[]> {
  const rows = await prisma.userRole.findMany({
    where: { roleId, user: { isActive: true } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/**
 * 指定ユーザー群を一時的に isActive=false にする。戻り値の関数を呼ぶと
 * isActive=true に復元できる（「最後の管理者保護」テストで、シードの
 * 初期管理者を一時退避させ、テスト後に必ず元へ戻すために使う）。
 */
export async function deactivateUsersTemporarily(
  prisma: PrismaClient,
  userIds: string[],
): Promise<() => Promise<void>> {
  if (userIds.length === 0) {
    return async () => {
      /* no-op */
    };
  }
  await prisma.user.updateMany({
    where: { id: { in: userIds } },
    data: { isActive: false },
  });
  return async () => {
    await prisma.user.updateMany({
      where: { id: { in: userIds } },
      data: { isActive: true },
    });
  };
}
