import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { User } from '@prisma/client';
import {
  AuditAction,
  AuditFailureCode,
  AuditResult,
  AuditTargetType,
  ErrorCode,
  type CurrentUserDto,
} from '@expense/shared';
import { AuditLogService } from '../audit/audit-log.service';
import type { AuthenticatedUser } from './current-user';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from './sessions.service';
import { getRoleNamesForUser } from './user-roles.util';

// ログイン失敗の連続回数・ロック時間（docs/api/pbi-1-2.md）。
const MAX_FAILED_LOGIN_COUNT = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

// タイミング攻撃対策（docs/api/pbi-1-2.md「タイミング攻撃対策」参照）：
// 存在しないユーザーでログインが試行された場合も、ダミーのargon2ハッシュに対して
// 検証処理を1回実行し、レスポンス時間を存在するユーザーの場合と揃える。
// このハッシュ自体に対応する平文パスワードは存在しない（検証は常にfalseになる）。
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$xltmmmWcFdE7HmAYrXi7tA$20MtADN77FU0q2EGI3z2fRri6la4OOCNW+cJcjAAuaM';

export interface LoginResult {
  user: CurrentUserDto;
  rawToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionsService: SessionsService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * ログイン処理。
   *
   * 認証失敗レスポンスの統一（docs/api/pbi-1-2.md）：
   * パスワード違い・存在しないユーザー・無効化済みユーザー・ロックアウト中の
   * いずれであっても、常に同一の AUTH_INVALID_CREDENTIALS を投げる
   * （ユーザー列挙対策のため、呼び出し側で理由ごとに分岐しないこと）。
   */
  async login(
    email: string,
    password: string,
    meta?: { userAgent?: string | null; ipAddress?: string | null },
  ): Promise<LoginResult> {
    const ipAddress = meta?.ipAddress ?? null;
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user) {
      // ユーザーが存在しない場合も、タイミング攻撃対策としてダミーハッシュで
      // 検証処理を1回実行し、存在するユーザーの場合と処理時間を揃える。
      await this.verifyPasswordSafely(DUMMY_PASSWORD_HASH, password);
      await this.recordLoginFailure(
        email,
        null,
        AuditFailureCode.LOGIN_UNKNOWN_EMAIL,
        ipAddress,
      );
      throw this.invalidCredentials();
    }

    if (!user.isActive) {
      await this.recordLoginFailure(
        email,
        user.id,
        AuditFailureCode.LOGIN_INACTIVE_USER,
        ipAddress,
      );
      throw this.invalidCredentials();
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await this.recordLoginFailure(
        email,
        user.id,
        AuditFailureCode.LOGIN_LOCKED,
        ipAddress,
      );
      throw this.invalidCredentials();
    }

    // パスワード検証（argon2）はトランザクションの外で行う
    // （重い処理の間、DB接続・行ロックを保持しない）。
    const passwordMatches = await this.verifyPasswordSafely(
      user.passwordHash,
      password,
    );

    if (!passwordMatches) {
      await this.recordFailedLogin(user, email, ipAddress);
      throw this.invalidCredentials();
    }

    // 失敗カウントのリセット・セッション作成・監査ログを同一トランザクションで行う。
    // 記録に失敗したらログイン自体も失敗する（fail closed）。
    // セッション固定対策：ログイン成功時に必ず新規セッションを発行する。
    const { rawToken } = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: null },
      });
      const created = await this.sessionsService.createSession(
        user.id,
        meta,
        tx,
      );
      await this.auditLog.record(tx, {
        actorUserId: user.id,
        action: AuditAction.LOGIN,
        result: AuditResult.SUCCESS,
        targetType: AuditTargetType.USER,
        targetId: user.id,
        ipAddress,
      });
      return created;
    });

    const roles = await getRoleNamesForUser(this.prisma, user.id);

    return {
      user: this.toCurrentUserDto(user, roles),
      rawToken,
    };
  }

  /**
   * ログアウト。セッションを今回失効させられたときだけ、同一トランザクションで記録する。
   */
  async logout(
    currentUser: Pick<AuthenticatedUser, 'id' | 'sessionId'>,
    ipAddress: string | null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const revoked = await this.sessionsService.revokeSession(
        currentUser.sessionId,
        tx,
      );
      if (revoked) {
        await this.auditLog.record(tx, {
          actorUserId: currentUser.id,
          action: AuditAction.LOGOUT,
          result: AuditResult.SUCCESS,
          targetType: AuditTargetType.SESSION,
          targetId: currentUser.sessionId,
          ipAddress,
        });
      }
    });
  }

  async getCurrentUser(userId: string): Promise<CurrentUserDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw this.invalidCredentials();
    }
    const roles = await getRoleNamesForUser(this.prisma, user.id);
    return this.toCurrentUserDto(user, roles);
  }

  private toCurrentUserDto(
    user: User,
    roles: CurrentUserDto['roles'],
  ): CurrentUserDto {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      roles,
      managerId: user.managerId,
    };
  }

  private async verifyPasswordSafely(
    hash: string,
    password: string,
  ): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      // ハッシュ形式が不正な場合（他実装からの移行データ等）も、
      // ログイン失敗として扱う（内部エラーの詳細はクライアントに返さない）。
      return false;
    }
  }

  // 業務更新を伴わない失敗（存在しない・無効化済み・ロック中）は記録のみ。
  // 記録に失敗したら、401ではなく500になる（監査できない状態では認証を進めない）。
  private async recordLoginFailure(
    email: string,
    targetUserId: string | null,
    failureCode: AuditFailureCode,
    ipAddress: string | null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.auditLog.record(tx, {
        actorUserId: null,
        actorEmail: email,
        action: AuditAction.LOGIN,
        result: AuditResult.FAILURE,
        failureCode,
        targetType: AuditTargetType.USER,
        targetId: targetUserId,
        ipAddress,
      });
    });
  }

  // パスワード違い：失敗カウント加算（ロックアウト設定を含む）と監査ログを同一トランザクションで行う。
  private async recordFailedLogin(
    user: User,
    email: string,
    ipAddress: string | null,
  ): Promise<void> {
    const nextFailedCount = user.failedLoginCount + 1;
    const shouldLock = nextFailedCount >= MAX_FAILED_LOGIN_COUNT;

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: nextFailedCount,
          lockedUntil: shouldLock
            ? new Date(Date.now() + LOCKOUT_DURATION_MS)
            : user.lockedUntil,
        },
      });
      await this.auditLog.record(tx, {
        actorUserId: null,
        actorEmail: email,
        action: AuditAction.LOGIN,
        result: AuditResult.FAILURE,
        failureCode: AuditFailureCode.LOGIN_BAD_PASSWORD,
        targetType: AuditTargetType.USER,
        targetId: user.id,
        ipAddress,
      });
    });
  }

  private invalidCredentials(): UnauthorizedException {
    return new UnauthorizedException({
      code: ErrorCode.AUTH_INVALID_CREDENTIALS,
      message:
        'メールアドレスまたはパスワードが違います。何度も失敗した場合は、しばらく時間をおいてください。',
    });
  }
}
