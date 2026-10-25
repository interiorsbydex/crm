import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/prisma.js', () => ({
  prisma: { user: { findFirst: vi.fn(), update: vi.fn() } },
}));

import { prisma } from '../lib/prisma.js';
import { incrementAssigned, selectBLForLead } from './assignmentService.js';

type TestUser = { id: string; role: string; isActive: boolean; totalLeadsAssigned: number };
const userModel = prisma.user as unknown as {
  findFirst: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

describe('active BL round-robin selection', () => {
  let users: TestUser[];

  beforeEach(() => {
    users = [
      { id: 'bl-a', role: 'BL', isActive: true, totalLeadsAssigned: 0 },
      { id: 'bl-b', role: 'BL', isActive: true, totalLeadsAssigned: 0 },
      { id: 'bl-inactive', role: 'BL', isActive: false, totalLeadsAssigned: 0 },
      { id: 'designer', role: 'DESIGNER', isActive: true, totalLeadsAssigned: 0 },
    ];
    userModel.findFirst.mockReset().mockImplementation(async ({ where, orderBy }: any) => {
      expect(where).toEqual({ role: 'BL', isActive: true });
      expect(orderBy).toEqual([{ totalLeadsAssigned: 'asc' }, { id: 'asc' }]);
      return users
        .filter((u) => u.role === where.role && u.isActive === where.isActive)
        .sort((a, b) => a.totalLeadsAssigned - b.totalLeadsAssigned || a.id.localeCompare(b.id))
        .map(({ id }) => ({ id }))[0] ?? null;
    });
    userModel.update.mockReset().mockImplementation(async ({ where }: any) => {
      users.find((u) => u.id === where.id)!.totalLeadsAssigned++;
      return users.find((u) => u.id === where.id);
    });
  });

  it('alternates among active BLs as their assignment counts increase', async () => {
    const first = await selectBLForLead();
    expect(first?.id).toBe('bl-a');
    await incrementAssigned(first!.id);
    const second = await selectBLForLead();
    expect(second?.id).toBe('bl-b');
    await incrementAssigned(second!.id);
    expect((await selectBLForLead())?.id).toBe('bl-a');
  });

  it('returns null when there are no active BLs', async () => {
    users.forEach((u) => { if (u.role === 'BL') u.isActive = false; });
    expect(await selectBLForLead()).toBeNull();
  });
});