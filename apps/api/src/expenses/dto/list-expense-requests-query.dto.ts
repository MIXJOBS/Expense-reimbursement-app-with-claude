import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';
import type { ListExpenseRequestsQuery } from '@expense/shared';

// GET /expenses のクエリパラメータDTO。
// page は1始まりの整数、未指定時は1（docs/api/pbi-3.md ページネーション仕様）。
// page=0・page=-1（1未満）・page=abc（数値でない）はいずれも400 VALIDATION_ERRORになる。
export class ListExpenseRequestsQueryDto implements ListExpenseRequestsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
