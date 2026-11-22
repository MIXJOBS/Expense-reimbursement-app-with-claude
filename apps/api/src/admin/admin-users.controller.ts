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
  UseGuards,
} from '@nestjs/common';
import { RoleName } from '@expense/shared';
import type {
  AdminRoleListItemDto,
  AdminUserListResponseDto,
} from '@expense/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/current-user';
import { RoleGuard } from './role.guard';
import { Roles } from './roles.decorator';
import { RolesService } from './roles.service';
import { GrantRoleDto } from './dto/grant-role.dto';

// PBI2: ロールと権限の管理API。
// 横断ルール1: ロールの有無はGuard（RoleGuard）で、本人かどうかはService層で判定する。
// 全エンドロールはADMINロール必須（@Roles(RoleName.ADMIN) + RoleGuard）。
@UseGuards(RoleGuard)
@Roles(RoleName.ADMIN)
@Controller('admin')
export class AdminUsersController {
  constructor(private readonly rolesService: RolesService) {}

  @Get('users')
  async listUsers(): Promise<AdminUserListResponseDto> {
    const items = await this.rolesService.listUsers();
    return { items };
  }

  @Get('roles')
  async listRoles(): Promise<AdminRoleListItemDto[]> {
    return this.rolesService.listRoles();
  }

  @Get('users/:userId/roles')
  async listUserRoles(
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ): Promise<AdminRoleListItemDto[]> {
    return this.rolesService.listUserRoles(userId);
  }

  @Post('users/:userId/roles')
  @HttpCode(HttpStatus.CREATED)
  async grantRole(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() dto: GrantRoleDto,
  ): Promise<void> {
    await this.rolesService.grantRole(currentUser.id, userId, dto.roleId);
  }

  @Delete('users/:userId/roles/:roleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeRole(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('roleId', new ParseUUIDPipe()) roleId: string,
  ): Promise<void> {
    await this.rolesService.revokeRole(currentUser.id, userId, roleId);
  }
}
