/**
 * Test leads never count as bookings on the designer dashboard, the same as
 * Reports and the designer/BL credit engines. Found live on 29 Oct: a cancelled
 * test lead (X8926) still showed as ₹10L booked on Arjun's dashboard, because
 * the cancellation check skipped test leads but the booking total did not.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('./dashboard.ts', import.meta.url)), 'utf8');

describe('designer dashboard booking leaves test leads out', () => {
  it('the booking total, the peer leaderboard and both cancellation checks all filter test leads', () => {
    const start = source.indexOf('// Booking achieved: sum estimatedValue');
    const booking = source.slice(start, source.indexOf('_sum: { estimatedValue: true }', start));
    expect(start).toBeGreaterThan(0);
    expect(booking).toContain('isTestLead: false');
    const peers = source.slice(source.indexOf("prisma.lead.groupBy({\n        by: ['assignedDesignerId']"));
    expect(peers.slice(0, 300)).toContain('isTestLead: false');
    expect(source).toContain('loadBookingCancellations({ ...leadWhere, isTestLead: false }, targetCycle)');
    expect(source).toMatch(/loadBookingCancellations\(\{\s*assignedDesignerId: \{ in: peerIds \}, isTestLead: false,/);
  });
});
