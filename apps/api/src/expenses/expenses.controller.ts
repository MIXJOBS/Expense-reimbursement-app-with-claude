import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type {
  ExpenseRequestDto,
  ExpenseRequestListResponseDto,
} from '@expense/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/current-user';
import { ExpensesService } from './expenses.service';
import { UpsertExpenseRequestDto } from './dto/upsert-expense-request.dto';
import { ListExpenseRequestsQueryDto } from './dto/list-expense-requests-query.dto';

// PBI3: 経費申請の登録・編集API。
// 横断ルール1: ログイン必須（@Public()は付けない）。ロール制限は不要
// （全社員がAPPLICANTロールを持つため）。本人かどうかはService層で、
// PrismaのwhereにapplicantId条件を含める形で判定する。
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expensesService: ExpensesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() dto: UpsertExpenseRequestDto,
  ): Promise<ExpenseRequestDto> {
    return this.expensesService.create(currentUser.id, dto);
  }

  @Get()
  async list(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Query() query: ListExpenseRequestsQueryDto,
  ): Promise<ExpenseRequestListResponseDto> {
    return this.expensesService.list(currentUser.id, query.page ?? 1);
  }

  @Get(':id')
  async findOne(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ExpenseRequestDto> {
    return this.expensesService.findOne(currentUser.id, id);
  }

  @Put(':id')
  async update(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpsertExpenseRequestDto,
  ): Promise<ExpenseRequestDto> {
    return this.expensesService.update(currentUser.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.expensesService.remove(currentUser.id, id);
  }

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  async submit(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ExpenseRequestDto> {
    return this.expensesService.submit(currentUser.id, id);
  }
}
