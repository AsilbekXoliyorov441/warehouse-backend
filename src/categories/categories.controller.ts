import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
import { ApiErrors } from '../common/swagger/api-docs.decorators';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';
import { CategoryDto, CategoryWithCountDto } from './dto/category.response';

@ApiTags('categories')
@ApiBearerAuth()
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Post()
  @RequirePermission(Permission.PRODUCT_MANAGE)
  @ApiOperation({ summary: 'Create a category' })
  @ApiCreatedResponse({ type: CategoryDto })
  @ApiErrors(ErrorCode.DUPLICATE_RESOURCE)
  create(@Body() dto: CreateCategoryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.categories.create(dto, user.id);
  }

  @Get()
  @RequirePermission(Permission.CATALOG_READ)
  @ApiOperation({ summary: 'List categories with product counts', description: 'Sorted by name.' })
  @ApiOkResponse({ type: [CategoryWithCountDto] })
  list() {
    return this.categories.list();
  }

  @Get(':id')
  @RequirePermission(Permission.CATALOG_READ)
  @ApiOperation({ summary: 'Get a category with its product count' })
  @ApiOkResponse({ type: CategoryWithCountDto })
  @ApiErrors(ErrorCode.RESOURCE_NOT_FOUND)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.categories.findOne(id);
  }

  @Patch(':id')
  @RequirePermission(Permission.PRODUCT_MANAGE)
  @ApiOperation({ summary: 'Rename a category' })
  @ApiOkResponse({ type: CategoryDto })
  @ApiErrors(ErrorCode.RESOURCE_NOT_FOUND, ErrorCode.DUPLICATE_RESOURCE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.categories.update(id, dto, user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(Permission.PRODUCT_MANAGE)
  @ApiOperation({
    summary: 'Delete an unused category',
    description: 'Fails with `CATEGORY_IN_USE` (details.productCount) while products reference it.',
  })
  @ApiNoContentResponse({ description: 'Category deleted' })
  @ApiErrors(ErrorCode.RESOURCE_NOT_FOUND, ErrorCode.CATEGORY_IN_USE)
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.categories.remove(id, user.id);
  }
}
