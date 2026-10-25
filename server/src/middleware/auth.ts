import type { Request, Response, NextFunction } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { prisma } from '../lib/prisma.js';
import type { Role } from '@prisma/client';

// ── Lazy Supabase admin client (created on first use, after dotenv loads) ────
let _adminClient: SupabaseClient | null = null;

function getAdminClient(): SupabaseClient {
  if (!_adminClient) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env',
      );
    }
    _adminClient = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return _adminClient;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  supabaseId: string;
  name: string;
  email: string;
  role: Role;
  blId: string | null;
  isActive: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// ── Middleware ─────────────────────────────────────────────────────────────────

export async function verifyToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const { data, error } = await getAdminClient().auth.getUser(token);

    if (error || !data.user) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { supabaseId: data.user.id },
      select: {
        id: true,
        supabaseId: true,
        name: true,
        email: true,
        role: true,
        blId: true,
        isActive: true,
      },
    });

    if (!user) {
      res.status(401).json({ error: 'User not found in FYX — contact admin' });
      return;
    }

    if (!user.isActive) {
      res.status(403).json({ error: 'Account is deactivated' });
      return;
    }

    req.user = user;
    next();
  } catch (err) {
    console.error('verifyToken error:', err);
    res.status(500).json({ error: 'Authentication check failed' });
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        error: `Access denied. Required role(s): ${roles.join(', ')}`,
      });
      return;
    }

    next();
  };
}
