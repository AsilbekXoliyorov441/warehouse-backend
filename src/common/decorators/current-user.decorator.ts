import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AppRequest, AuthenticatedUser } from '../interfaces/request-context.interface';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const user = ctx.switchToHttp().getRequest<AppRequest>().user;
    if (!user) throw new Error('CurrentUser used on a route without authentication');
    return user;
  },
);
