import { vi, type Mock } from 'vitest';

// These route tests await vi.fn() query doubles; they do not use Prisma's
// fluent relation API. Retain the query arguments and resolved row type while
// allowing mock implementations to return ordinary promises.
export function mockPrismaQuery<T extends (...args: never[]) => PromiseLike<unknown>>(query: T) {
  if (!vi.isMockFunction(query)) {
    throw new Error('mockPrismaQuery requires an existing Vitest mock');
  }
  return query as unknown as Mock<(...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>>>;
}
