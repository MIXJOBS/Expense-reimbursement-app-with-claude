import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * PrismaService をアプリ全体で使えるようにするグローバルモジュール。
 * 各機能モジュールで PrismaModule を import しなくても PrismaService を注入できる。
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
