import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * PrismaClient をNestJSのライフサイクルに乗せるための薄いラッパー。
 *
 * - 本番のクエリログにはパスワードやCookie等の機微情報が含まれないようにする
 *   （横断ルール5: ログにパスワード・Cookie・トークンを出力しない）。
 * - 業務モデルがまだ無いため、接続/切断のライフサイクル管理のみを提供する。
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Prisma connected to database');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
