/**
 * User Invite Acceptance — public routes (no auth required)
 *
 * GET  /api/accept-invite/:token  — validate token, return email/role/name
 * POST /api/accept-invite/:token  — set password, create Supabase user + DB user
 */

import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { recordTeamChange } from '../lib/blTeamHistory.js';
import { createClient } from '@supabase/supabase-js';

export const acceptInviteRouter = Router();

// ── GET /api/accept-invite/:token ─────────────────────────────────────────────
acceptInviteRouter.get('/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const invite = await prisma.userInvite.findUnique({ where: { token } });

    if (!invite) {
      res.status(404).json({ error: 'Invite not found or already used' });
      return;
    }
    if (invite.acceptedAt) {
      res.status(410).json({ error: 'Invite has already been accepted' });
      return;
    }
    if (invite.expiresAt < new Date()) {
      res.status(410).json({ error: 'Invite has expired' });
      return;
    }

    res.json({ email: invite.email, role: invite.role, name: invite.name });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/accept-invite/:token ────────────────────────────────────────────
acceptInviteRouter.post('/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { password, confirmPassword } = req.body as {
      password?: string;
      confirmPassword?: string;
    };

    if (!password?.trim() || password !== confirmPassword) {
      res.status(400).json({ error: 'Passwords do not match or are missing' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }

    const invite = await prisma.userInvite.findUnique({ where: { token } });

    if (!invite) {
      res.status(404).json({ error: 'Invite not found' });
      return;
    }
    if (invite.acceptedAt) {
      res.status(410).json({ error: 'Invite already accepted' });
      return;
    }
    if (invite.expiresAt < new Date()) {
      res.status(410).json({ error: 'Invite has expired' });
      return;
    }

    // Check if a User record already exists (created by admin invite before this)
    const existingUser = await prisma.user.findUnique({ where: { email: invite.email } });

    // Create Supabase Auth user
    let supabaseId = existingUser?.supabaseId ?? `pending-${Date.now()}`;
    if (supabaseAdmin) {
      try {
        const { data, error } = await (supabaseAdmin as any).auth.admin.createUser({
          email: invite.email,
          password,
          email_confirm: true,
        });
        if (data?.user?.id) supabaseId = data.user.id;
        if (error) {
          console.warn('[accept-invite] Supabase create error:', error.message);
          // Someone invited again who already has a sign-in (e.g. rejoining):
          // the password they just chose becomes their password.
          if (existingUser?.supabaseId && !existingUser.supabaseId.startsWith('pending-')) {
            const { error: updErr } = await (supabaseAdmin as any).auth.admin.updateUserById(existingUser.supabaseId, { password });
            if (updErr) console.warn('[accept-invite] Supabase password update error:', updErr.message);
          }
        }
      } catch (e) {
        console.warn('[accept-invite] Supabase admin not available');
      }
    }

    // Create or update User record — carry through the blId/designation the
    // admin selected on the invite form so the person lands with the same
    // reporting line / title, not a bare role.
    const user = existingUser
      ? await prisma.user.update({
          where: { id: existingUser.id },
          data: { supabaseId, isActive: true, blId: invite.blId ?? undefined, designation: invite.designation ?? undefined },
        })
      : await prisma.user.create({
          data: {
            supabaseId,
            name: invite.name,
            email: invite.email,
            role: invite.role,
            blId: invite.blId ?? undefined,
            designation: invite.designation ?? undefined,
            isActive: true,
          },
        });

    if (existingUser) await recordTeamChange(user.id, existingUser, user);

    // Mark invite as accepted
    await prisma.userInvite.update({
      where: { token },
      data: { acceptedAt: new Date() },
    });

    // Sign the new person in with a real session — the same kind /auth/login
    // gives — so every API call accepts it. (A home-made JWT was returned here
    // before; the server never accepted it, so the app fell back to whatever
    // sign-in the browser already held — on a shared computer, someone else's.)
    // If sign-in fails, the client sends them to the login page instead.
    let session: { access_token: string; refresh_token: string } | null = null;
    if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && !supabaseId.startsWith('pending-')) {
      try {
        const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data, error } = await client.auth.signInWithPassword({ email: invite.email, password });
        if (error) console.warn('[accept-invite] sign-in after accept failed:', error.message);
        if (data?.session && data.user?.id === supabaseId) session = data.session;
      } catch (e: any) {
        console.warn('[accept-invite] sign-in after accept failed:', e.message);
      }
    }

    res.json({
      accessToken: session?.access_token ?? null,
      refreshToken: session?.refresh_token ?? null,
      user: { id: user.id, name: user.name, role: user.role, email: user.email, blId: user.blId },
    });
  } catch (err: any) {
    console.error('[accept-invite]', err.message);
    res.status(500).json({ error: err.message });
  }
});
