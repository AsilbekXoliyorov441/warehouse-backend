import { createTestApp, TestContext } from './utils/test-app';

interface Operation {
  operationId: string;
  description?: string;
  security?: Record<string, string[]>[];
  responses: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}
interface Spec {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown> };
}

describe('OpenAPI document (e2e)', () => {
  let ctx: TestContext;
  let spec: Spec;
  let operations: [string, Operation][];

  beforeAll(async () => {
    ctx = await createTestApp({ swagger: true });
    spec = (await ctx.http().get('/api/docs-json').expect(200)).body as Spec;
    operations = Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.entries(item).map(([method, op]): [string, Operation] => [
        `${method.toUpperCase()} ${path}`,
        op,
      ]),
    );
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('serves Swagger UI and the YAML document', async () => {
    await ctx.http().get('/api/docs').expect(200).expect('Content-Type', /html/);
    await ctx.http().get('/api/docs-yaml').expect(200);
  });

  it('gives every operation a unique id and a documented success response', () => {
    const ids = operations.map(([, op]) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [name, op] of operations) {
      const success = Object.keys(op.responses).filter((s) => s.startsWith('2'));
      expect({ name, success: success.length > 0 }).toEqual({ name, success: true });
      for (const status of success.filter((s) => s !== '204')) {
        const schema = op.responses[status].content?.['application/json']?.schema;
        expect({ name, status, hasSchema: schema !== undefined }).toEqual({
          name,
          status,
          hasSchema: true,
        });
      }
    }
  });

  it('documents 401 on every bearer-protected operation', () => {
    for (const [name, op] of operations) {
      if (!op.security?.some((s) => 'bearer' in s)) continue;
      expect({ name, has401: '401' in op.responses }).toEqual({ name, has401: true });
    }
  });

  it('derives permission notes from the enforced decorators', () => {
    const sale = spec.paths['/api/inventory/sales'].post;
    expect(sale.description).toContain('`SALE_CREATE`');
    expect(sale.description).toContain('`SELLER`');
    expect(Object.keys(sale.responses)).toEqual(expect.arrayContaining(['403', '409']));
    expect(spec.paths['/api/users'].get.description).toContain('`USER_MANAGE`');
  });

  it('publishes the error and Socket.IO payload schemas', () => {
    expect(Object.keys(spec.components.schemas)).toEqual(
      expect.arrayContaining(['ApiErrorDto', 'ErrorCode', 'InventoryUpdatedEvent', 'ProductPage']),
    );
  });
});
