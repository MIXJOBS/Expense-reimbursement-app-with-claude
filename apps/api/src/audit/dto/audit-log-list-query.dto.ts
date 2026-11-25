import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import {
  ALL_AUDIT_TARGET_TYPES,
  AUDIT_ACTOR_EMAIL_MAX_LENGTH,
  AUDIT_LOG_MAX_PAGE,
  type AuditLogListQuery,
  type AuditTargetType,
} from '@expense/shared';

// タイムゾーンのオフセット（Z または +09:00 形式）が必須のISO8601日時。
// 秒なし（2026-11-01T00:00+09:00）・ミリ秒あり（…:00.000Z）も受け付ける。
// 日付だけ・オフセット無しは400（タイムゾーンの取り違えを防ぐ。docs/api/pbi-6.md）。
const ISO_DATETIME_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

// 形式に加えて、実在する日時か（2026-02-30・25時・オフセット+99:00などを弾く）も確認する。
// Date.parse は 2月30日を3月2日に繰り上げて受け付けてしまうため、各部分を自前で確認する。
function isRealInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = ISO_DATETIME_WITH_OFFSET.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(
    Number,
  );
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const offsetHour = m[7] === undefined ? 0 : Number(m[7]);
  const offsetMinute = m[8] === undefined ? 0 : Number(m[8]);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    !Number.isNaN(Date.parse(value))
  );
}

@ValidatorConstraint({ name: 'isOffsetDateTime', async: false })
class IsOffsetDateTimeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isRealInstant(value);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be an ISO 8601 datetime with a timezone offset`;
  }
}

@ValidatorConstraint({ name: 'isAfterFrom', async: false })
class IsAfterFromConstraint implements ValidatorConstraintInterface {
  validate(to: unknown, args: ValidationArguments): boolean {
    const from = (args.object as { from?: unknown }).from;
    // どちらかが不正・未指定なら、このチェックは対象外（個別の検証が先に失敗する）。
    if (!isRealInstant(from) || !isRealInstant(to)) {
      return true;
    }
    return Date.parse(from) < Date.parse(to);
  }

  defaultMessage(): string {
    return 'to must be later than from';
  }
}

// GET /admin/audit-logs のクエリDTO。すべて任意。
// pageSize・action・result は項目を設けない（付けると forbidNonWhitelisted で400）。
export class AuditLogListQueryDto implements AuditLogListQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(AUDIT_LOG_MAX_PAGE)
  page?: number;

  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(AUDIT_ACTOR_EMAIL_MAX_LENGTH)
  actorEmail?: string;

  @IsOptional()
  @IsIn(ALL_AUDIT_TARGET_TYPES)
  targetType?: AuditTargetType;

  @IsOptional()
  @IsUUID()
  targetId?: string;

  @IsOptional()
  @Validate(IsOffsetDateTimeConstraint)
  from?: string;

  @IsOptional()
  @Validate(IsOffsetDateTimeConstraint)
  @Validate(IsAfterFromConstraint)
  to?: string;
}
