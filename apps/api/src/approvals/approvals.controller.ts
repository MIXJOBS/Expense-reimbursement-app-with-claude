import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  RoleName,
  type ApprovalListResponseDto,
  type ExpenseRequestDto,
} from '@expense/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/current-user';
import { RoleGuard } from '../admin/role.guard';
import { Roles } from '../admin/roles.decorator';
import { ApprovalsService } from './approvals.service';
import { ReturnExpenseRequestDto } from './dto/return-expense-request.dto';

// PBI4: 承認・差し戻しAPI（承認者向け）。
// 横断ルール1: ロール（MANAGER）はGuardで、承認者本人かどうか・自分の申請でないことは
// Service層でPrismaのwhere条件に含めて判定する。
@UseGuards(RoleGuard)
@Roles(RoleName.MANAGER)
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvalsService: ApprovalsService) {}

  @Get()
  async list(
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<ApprovalListResponseDto> {
    return this.approvalsService.list(currentUser.id);
  }

  @Get(':id')
  async findOne(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ExpenseRequestDto> {
    return this.approvalsService.findOne(currentUser.id, id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  async approve(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ExpenseRequestDto> {
    return this.approvalsService.approve(currentUser.id, id);
  }

  @Post(':id/return')
  @HttpCode(HttpStatus.OK)
  async returnRequest(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReturnExpenseRequestDto,
  ): Promise<ExpenseRequestDto> {
    return this.approvalsService.returnRequest(currentUser.id, id, dto.reason);
  }
}
