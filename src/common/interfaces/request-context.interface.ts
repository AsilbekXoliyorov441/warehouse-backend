import type { Request } from 'express';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
}

export interface AppRequest extends Request {
  requestId: string;
  user?: AuthenticatedUser;
}
