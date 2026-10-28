import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
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
import {
  CreateProductDto,
  ProductQueryDto,
  UpdateProductDto,
  UpdateProductStatusDto,
} from './dto/product.dto';
import { ProductDto } from './dto/product.response';
import { ProductsService } from './products.service';

@ApiTags('products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Post()
  @RequirePermission(Permission.PRODUCT_MANAGE)
  @ApiOperation({
    summary: 'Create a product',
    description:
      'SKU is unique and stored upper-case. Price is a decimal string. Stock is never set here; record a receipt instead.',
  })
  @ApiCreatedResponse({ type: ProductDto })
  @ApiErrors(ErrorCode.DUPLICATE_SKU)
  create(@Body() dto: CreateProductDto, @CurrentUser() user: AuthenticatedUser) {
    return this.products.create(dto, user.id);
  }

  @Get()
  @RequirePermission(Permission.CATALOG_READ)
  @ApiOperation({ summary: 'Search, filter and paginate products' })
  @ApiPage(ProductDto)
  list(@Query() query: ProductQueryDto) {
    return this.products.list(query);
  }

  @Get(':id')
  @RequirePermission(Permission.CATALOG_READ)
  @ApiOperation({ summary: 'Get a product' })
  @ApiOkResponse({ type: ProductDto })
  @ApiErrors(ErrorCode.RESOURCE_NOT_FOUND)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.findOne(id);
  }

  @Patch(':id')
  @RequirePermission(Permission.PRODUCT_MANAGE)
  @ApiOperation({
    summary: 'Update catalog fields',
    description:
      'SKU and stock cannot be changed here; use `PATCH /products/{id}/status` to (de)activate.',
  })
  @ApiOkResponse({ type: ProductDto })
  @ApiErrors(ErrorCode.RESOURCE_NOT_FOUND)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.products.update(id, dto, user.id);
  }

  @Patch(':id/status')
  @RequirePermission(Permission.PRODUCT_MANAGE)
  @ApiOperation({
    summary: 'Activate or deactivate a product',
    description:
      'Soft delete: inactive products keep their history but reject receipts, sales, adjustments and new transfers (`PRODUCT_INACTIVE`).',
  })
  @ApiOkResponse({ type: ProductDto })
  @ApiErrors(ErrorCode.RESOURCE_NOT_FOUND)
  setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.products.setStatus(id, dto.isActive, user.id);
  }
}
