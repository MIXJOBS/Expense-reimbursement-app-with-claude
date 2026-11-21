import { SetMetadata } from '@nestjs/common';

// 横断ルール1: 全APIをログイン必須にし、公開APIだけ @Public() で例外にする。
// SessionAuthGuard（グローバルガード）がこのメタデータを見て、
// 認証チェックをスキップするかどうかを判定する。
export const IS_PUBLIC_KEY = 'isPublic';

export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
