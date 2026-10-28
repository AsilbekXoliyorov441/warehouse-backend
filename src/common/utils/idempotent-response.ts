import type { Response } from 'express';
import type { IdempotentResult } from '../../idempotency/idempotency.service';

/** Unwraps an idempotent result, telling the client whether it was a replay. */
export function withReplayHeader<T>(res: Response, result: IdempotentResult<T>): T {
  res.setHeader('Idempotent-Replayed', String(result.replayed));
  return result.body;
}
