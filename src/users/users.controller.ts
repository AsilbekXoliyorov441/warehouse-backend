import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '../common/constants/permissions';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/permissions.decorator';
import { ErrorCode } from '../common/errors/error-codes';
import type { AuthenticatedUser } from '../common/interfaces/request-context.interface';
import { ApiErrors, ApiPage } from '../common/swagger/api-docs.decorators';
import { CreateUserDto } from './dto/create-user.dto';
import { ResetPasswordDto, UpdateUserDto } from './dto/update-user.dto';
import { UserDetailDto, UserDto } from './dto/user.response';
import { UserQueryDto } from './dto/user-query.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@RequirePermission(Permission.USER_MANAGE)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a user',
    description: 'The account has no branch access until a membership is added.',
  })
  @ApiCreatedResponse({ type: UserDto })
  @ApiErrors(ErrorCode.EMAIL_ALREADY_REGISTERED)
  create(@Body() dto: CreateUserDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.users.create(dto, actor.id);
  }

  @Get()
  @ApiOperation({ summary: 'List users', description: 'Newest first. `q` matches name or email.' })
  @ApiPage(UserDto)
  list(@Query() query: UserQueryDto) {
    return this.users.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a user with all branch memberships' })
  @ApiOkResponse({ type: UserDetailDto })
  @ApiErrors(ErrorCode.RESOURCE_NOT_FOUND)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.findById(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Rename or (de)activate a user',
    description:
      'Deactivation revokes all sessions and disconnects the user’s sockets immediately. You cannot deactivate yourself.',
  })
  @ApiOkResponse({ type: UserDto })
  @ApiErrors(ErrorCode.RESOURCE_NOT_FOUND)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.users.update(id, dto, actor.id);
  }

  @Post(':id/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Reset a user's password",
    description:
      'Sets a new password and revokes all of the user’s sessions. Use `POST /auth/change-password` for your own account.',
  })
  @ApiNoContentResponse({ description: 'Password reset; sessions revoked' })
  @ApiErrors(ErrorCode.RESOURCE_NOT_FOUND)
  resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetPasswordDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.users.resetPassword(id, dto.password, actor.id);
  }
}
