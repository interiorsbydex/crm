import { Router } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../middleware/auth.js';

export const authRouter = Router();

// ── Lazy Supabase anon client ─────────────────────────────────────────────────
let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env');
    }
    _client = createClient(url, key);
  }
  return _client;
}

// ── Retry helper ───────────────────────────────────────────────────────────────
// Production's Postgres connection is periodically recycled by the platform
// ("terminating connection due to administrator command"). Prisma's pool
// reconnects on the *next* query, so a single transient failure here should be
// retried once rather than surfaced as a login failure to the user.
async function withDbRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    console.warn('[auth] transient DB error, retrying once:', (e as Error).message);
    return fn();
  }
}

/**
 * POST /api/auth/login
 * Body: { email, password }
 * Returns: { accessToken, refreshToken, user }
 */
authRouter.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };

    if (!email || !password) {
      res.status(400).json({ error: 'email and password are required' });
      return;
    }

    const { data, error } = await getClient().auth.signInWithPassword({ email, password });

    if (error || !data.user || !data.session) {
      res.status(401).json({ error: error?.message ?? 'Login failed' });
      return;
    }

    const crmUser = await withDbRetry(() =>
      prisma.user.findUnique({
        where: { supabaseId: data.user.id },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          blId: true,
          isActive: true,
        },
      }),
    );

    if (!crmUser) {
      res.status(401).json({ error: 'No CRM account found — contact admin' });
      return;
    }

    if (!crmUser.isActive) {
      res.status(403).json({ error: 'Account is deactivated' });
      return;
    }

    res.json({
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      user: crmUser,
    });
  } catch (e) {
    console.error('[auth] /login failed:', e);
    res.status(500).json({ error: 'Login temporarily unavailable — please try again' });
  }
});

/**
 * POST /api/auth/refresh
 * Body: { refreshToken }
 * Returns: { accessToken, refreshToken }
 */
authRouter.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body as { refreshToken?: string };

    if (!refreshToken) {
      res.status(400).json({ error: 'refreshToken is required' });
      return;
    }

    const { data, error } = await getClient().auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error || !data.session) {
      res.status(401).json({ error: 'Invalid or expired refresh token' });
      return;
    }

    res.json({
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
    });
  } catch (e) {
    console.error('[auth] /refresh failed:', e);
    res.status(500).json({ error: 'Session refresh temporarily unavailable — please try again' });
  }
});

/**
 * GET /api/auth/me
 * Headers: Authorization: Bearer <token>
 * Returns: { user }
 */
authRouter.get('/me', verifyToken, (req, res) => {
  res.json({ user: req.user });
});

/**
 * POST /api/auth/logout
 * Headers: Authorization: Bearer <token>
 */
authRouter.post('/logout', verifyToken, async (_req, res) => {
  try {
    await getClient().auth.signOut();
    res.json({ message: 'Logged out' });
  } catch (e) {
    console.error('[auth] /logout failed:', e);
    res.status(500).json({ error: 'Logout temporarily unavailable — please try again' });
  }
});
