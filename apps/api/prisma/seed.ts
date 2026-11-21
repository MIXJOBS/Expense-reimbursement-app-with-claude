// Prisma seed スクリプト。
//
// 投入内容（docs/api/pbi-1-2.md「シード方針」参照）:
//   1. Role マスタ4種（APPLICANT, MANAGER, ACCOUNTING, ADMIN）を upsert で投入。
//   2. 初期管理者 User（ADMINロール付き）を1件 upsert で投入。
//
// 初期管理者のパスワードは環境変数 SEED_ADMIN_PASSWORD から読み込む。
// ハードコードしたデフォルト値は使わず、未設定の場合はエラーで処理を止める
// （秘密情報をリポジトリに残さないため。CLAUDE.md「やっちゃダメなこと」参照）。
//
// 実行方法: `prisma db seed`（apps/api/package.json の `prisma.seed` 設定経由）。
// どのDATABASE_URLに対して実行されるかは、呼び出し側（dotenv-cli等で読み込む
// .env / .env.test）に依存する。本スクリプト自身は接続先の切り替えを行わない。
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { RoleName, ALL_ROLE_NAMES } from '@expense/shared';

const prisma = new PrismaClient();

const SEED_ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
const SEED_ADMIN_NAME = process.env.SEED_ADMIN_NAME ?? '初期管理者';

async function main(): Promise<void> {
  const seedAdminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!seedAdminPassword) {
    throw new Error(
      'SEED_ADMIN_PASSWORD が未設定です。.env もしくは .env.test に SEED_ADMIN_PASSWORD を設定してください（ハードコードしたデフォルト値は使用しません）。',
    );
  }

  // 1. Role マスタ4種を upsert
  const roleByName = new Map<RoleName, { id: string; name: string }>();
  for (const name of ALL_ROLE_NAMES) {
    const role = await prisma.role.upsert({
      where: { name },
      update: {},
      create: { name },
    });
    roleByName.set(name, role);
  }

  // 2. 初期管理者 User を upsert（パスワードはargon2idでハッシュ化）
  const passwordHash = await argon2.hash(seedAdminPassword, { type: argon2.argon2id });

  const adminUser = await prisma.user.upsert({
    where: { email: SEED_ADMIN_EMAIL },
    update: {
      // 既存レコードがある場合、パスワードやisActiveを seed 実行のたびに
      // 上書きしてしまうと事故につながるため、create時のみ設定し、
      // update時は name 等の非機密項目のみ更新する。
      name: SEED_ADMIN_NAME,
    },
    create: {
      email: SEED_ADMIN_EMAIL,
      name: SEED_ADMIN_NAME,
      passwordHash,
      isActive: true,
    },
  });

  const adminRole = roleByName.get(RoleName.ADMIN);
  if (!adminRole) {
    throw new Error('ADMIN ロールのseedに失敗しました。');
  }

  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: adminUser.id, roleId: adminRole.id } },
    update: {},
    create: {
      userId: adminUser.id,
      roleId: adminRole.id,
      grantedById: null, // 初期投入のため付与者なし
    },
  });

  console.log(`[seed] Role x${roleByName.size} 件 投入済み`);
  console.log(`[seed] 初期管理者 User (${SEED_ADMIN_EMAIL}) に ADMIN ロールを付与済み`);
}

main()
  .catch((e) => {
    // パスワード等の秘密情報を含まないエラーのみ出力する。
    console.error('[seed] 失敗:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
