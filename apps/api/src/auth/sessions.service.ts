import * as crypto from 'crypto';
import { Injectable } from '@nestjs/common';
import { Prisma, Session, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

// セッション固定対策・絶対期限/スライディング期限を踏まえたセッション管理の共通ロジック。
// docs/api/pbi-1-2.md:
// - 絶対有効期限: ログイン時に now + 8h で固定（expiresAt）
// - スライディング有効期限: 無操作30分（lastSeenAt基準）
// - lastSeenAt の更新は1分間隔で間引く
// - セッションIDはCookieにランダムな生トークンを渡し、DBにはSHA-256ハッシュのみ保存する
//   （DBダンプ漏洩時にCookie値が直接露出しないようにするため）
export const SESSION_COOKIE_NAME = 'sid';

const ABSOLUTE_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8時間
const SLIDING_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30分
const LAST_SEEN_UPDATE_THROTTLE_MS = 60 * 1000; // 1分

export interface CreatedSession {
  rawToken: string;
  session: Session;
}

@Injectable()
export class SessionsService {
  constructor(private readonly prisma: PrismaService) {}

  hashToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }

  generateRawToken(): string {
    // 推測不能なランダム文字列（32byte = 256bit）。
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * 新規セッションを作成する（ログイン成功時）。
   * セッション固定対策のため、ログイン成功時は必ず新規トークンを発行する
   * （呼び出し側で旧セッションのrevokeを別途行う想定）。
   */
  async createSession(
    userId: string,
    meta?: { userAgent?: string | null; ipAddress?: string | null },
    // 監査ログと同じトランザクションで作る場合に tx を渡す（PBI6）。
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<CreatedSession> {
    const rawToken = this.generateRawToken();
    const now = new Date();
    const session = await client.session.create({
      data: {
        tokenHash: this.hashToken(rawToken),
        userId,
        userAgent: meta?.userAgent ?? null,
        ipAddress: meta?.ipAddress ?? null,
        expiresAt: new Date(now.getTime() + ABSOLUTE_SESSION_TTL_MS),
        lastSeenAt: now,
      },
    });
    return { rawToken, session };
  }

  /**
   * セッションを失効させる。実際に失効させた（今回revokedAtを入れた）ときだけ true。
   * 監査ログと同じトランザクションで行う場合に tx を渡す（PBI6）。
   */
  async revokeSession(
    sessionId: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<boolean> {
    const result = await client.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count === 1;
  }

  /**
   * 生トークンから有効なセッション＋ユーザーを検証して取得する。
   * 無効（存在しない・revoked・絶対期限切れ・スライディング期限切れ・
   * ユーザー無効化済み）の場合は null を返す（呼び出し側で401にする）。
   */
  async validateSession(
    rawToken: string,
  ): Promise<{ session: Session; user: User } | null> {
    const tokenHash = this.hashToken(rawToken);
    const sessionWithUser = await this.prisma.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!sessionWithUser) {
      return null;
    }

    const { user, ...session } = sessionWithUser;
    const now = new Date();

    if (session.revokedAt !== null) {
      return null;
    }

    if (session.expiresAt.getTime() <= now.getTime()) {
      return null;
    }

    if (
      now.getTime() - session.lastSeenAt.getTime() >
      SLIDING_IDLE_TIMEOUT_MS
    ) {
      return null;
    }

    if (!user.isActive) {
      return null;
    }

    await this.touchLastSeenAt(session.id, session.lastSeenAt, now);

    return { session, user };
  }

  /**
   * lastSeenAt の更新を1分間隔で間引く。
   * 前回更新から1分未満の場合は何もしない（書き込み負荷軽減）。
   */
  private async touchLastSeenAt(
    sessionId: string,
    lastSeenAt: Date,
    now: Date,
  ): Promise<void> {
    if (now.getTime() - lastSeenAt.getTime() < LAST_SEEN_UPDATE_THROTTLE_MS) {
      return;
    }
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { lastSeenAt: now },
    });
  }
}
