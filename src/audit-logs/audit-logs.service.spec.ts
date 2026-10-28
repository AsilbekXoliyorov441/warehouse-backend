import { sanitizeMetadata } from './audit-logs.service';

describe('sanitizeMetadata', () => {
  it('drops credential-like keys at any depth', () => {
    expect(
      sanitizeMetadata({
        email: 'a@b.c',
        password: 'x',
        nested: {
          refreshToken: 'y',
          passwordHash: 'z',
          keep: 1,
          list: [{ accessToken: 'q', ok: true }],
        },
      }),
    ).toEqual({ email: 'a@b.c', nested: { keep: 1, list: [{ ok: true }] } });
  });
});
