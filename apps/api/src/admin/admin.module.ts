import { Module } from '@nestjs/common';
import { AdminUsersController } from './admin-users.controller';
import { RolesService } from './roles.service';

@Module({
  controllers: [AdminUsersController],
  providers: [RolesService],
})
export class AdminModule {}
