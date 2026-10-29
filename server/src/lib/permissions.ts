/**
 * Permissions (Admin → Permissions): which roles may do each of these actions.
 *
 * Each permission starts with exactly the roles the CRM gave it before this
 * setting existed, and an admin can only switch a role off or back on among
 * those (`roles`): the screens and checks behind each action were built for
 * those roles (e.g. "assign directly" assumes the user is a BL with a team),
 * so granting it to anyone else would misbehave. The Branch Head keeps every
 * permission it starts with, so nobody can be locked out of the admin screens —
 * except rows marked `branchHeadOptional` (switching those off can't lock anyone out).
 */
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ConfigError, describeIssues, versionedConfig } from './versionedConfig.js';

export type PermRole = 'DESIGNER' | 'DESIGN_MANAGER' | 'CRE' | 'BL' | 'BRANCH_HEAD';

/**
 * `roles`: the roles the action was built for. `defaultRoles`: who has it before an admin changes anything (default: all of `roles`).
 * `branchHeadOptional`: the Branch Head may switch this one off for itself too.
 */
export interface PermissionDef { key: string; label: string; area: string; roles: PermRole[]; defaultRoles?: PermRole[]; branchHeadOptional?: boolean }

export const PERMISSIONS: PermissionDef[] = [
  { key: 'LEAD_CREATE_MANUAL', area: 'Leads', label: 'Quick-capture walk-in and referral leads', roles: ['CRE', 'BL', 'BRANCH_HEAD'] },
  { key: 'LEAD_IMPORT', area: 'Leads', label: 'Import leads from a spreadsheet', roles: ['BL', 'BRANCH_HEAD'] },
  { key: 'LEAD_ALLOCATE_BL', area: 'Leads', label: 'Allocate an MQL lead to a Business Lead', roles: ['CRE', 'BRANCH_HEAD'] },
  { key: 'LEAD_EXPORT', area: 'Leads', label: 'Download the lead list (Export CSV / Excel on the Leads screen; Excel is Branch Head only)', roles: ['BL', 'BRANCH_HEAD'], defaultRoles: [], branchHeadOptional: true },
  { key: 'LEAD_PUSHBACK_MQL', area: 'Leads', label: 'Send an MQL lead back to Effective Lead', roles: ['BL', 'BRANCH_HEAD'] },
  { key: 'STAGE_OVERRIDE', area: 'Leads', label: 'Push a stuck lead forward past missing requirements (reason required)', roles: ['BL', 'BRANCH_HEAD'], defaultRoles: ['BRANCH_HEAD'] },
  { key: 'WHATSAPP_ALL_CHATS', area: 'Leads', label: 'See every WhatsApp chat in the inbox (otherwise only chats of leads they can open)', roles: ['DESIGNER', 'CRE', 'BL', 'BRANCH_HEAD'], defaultRoles: ['BRANCH_HEAD'] },
  { key: 'LEAD_ASSIGN_DIRECT', area: 'Leads', label: 'Assign a lead directly to a designer', roles: ['BL'] },
  { key: 'PROJECT_TEAM_REQUEST', area: 'Projects', label: 'Add or request project team members', roles: ['DESIGNER', 'BL', 'BRANCH_HEAD'] },
  { key: 'PROJECT_TEAM_APPROVE', area: 'Projects', label: 'Approve or reject team members, and choose the primary', roles: ['BL', 'BRANCH_HEAD'] },
  { key: 'DIP_CHECKLIST_EDIT', area: 'Projects', label: 'Tick items on the OBM → DIP checklist', roles: ['BL'] },
  { key: 'OFFERS_MANAGE', area: 'Sales', label: 'Create, edit and delete offers', roles: ['BL', 'BRANCH_HEAD'] },
  { key: 'SLA_MANAGE', area: 'Team', label: 'See and resolve SLA breaches', roles: ['BL', 'BRANCH_HEAD'] },
  { key: 'TEAM_TASKS_VIEW', area: 'Team', label: "See the team's tasks", roles: ['BL', 'BRANCH_HEAD'] },
  { key: 'ATTENDANCE_CREDITS', area: 'Team', label: "Approve designers' attendance credits", roles: ['BL', 'BRANCH_HEAD'] },
];
const BY_KEY = new Map(PERMISSIONS.map((p) => [p.key, p]));

/** Per permission, the roles that have it. */
export type PermissionSettings = Record<string, PermRole[]>;

export function defaultPermissions(): PermissionSettings {
  return Object.fromEntries(PERMISSIONS.map((p) => [p.key, [...(p.defaultRoles ?? p.roles)]]));
}

function mergePermissions(saved: Partial<PermissionSettings> | undefined): PermissionSettings {
  const d = defaultPermissions();
  for (const [key, roles] of Object.entries(saved ?? {})) {
    const def = BY_KEY.get(key);
    if (!def || !roles) continue;
    // Only roles the action was built for; the Branch Head keeps it unless the row lets it switch off.
    d[key] = def.roles.filter((r) => (r === 'BRANCH_HEAD' && !def.branchHeadOptional) || roles.includes(r));
  }
  return d;
}

export const permissionsConfig = versionedConfig<PermissionSettings>({
  key: 'permissions_v1',
  action: 'PERMISSIONS',
  noun: 'the permissions',
  defaults: defaultPermissions,
  merge: mergePermissions,
  validate: (raw) => {
    const parsed = z.record(z.string(), z.array(z.enum(['DESIGNER', 'DESIGN_MANAGER', 'CRE', 'BL', 'BRANCH_HEAD']))).safeParse(raw);
    if (!parsed.success) throw new ConfigError(400, 'The permissions could not be saved', describeIssues(parsed.error.issues, Object.fromEntries(PERMISSIONS.map((p) => [p.key, p.label]))));
    const problems: string[] = [];
    for (const [key, roles] of Object.entries(parsed.data)) {
      const def = BY_KEY.get(key);
      if (!def) { problems.push(`Unknown permission "${key}"`); continue; }
      for (const r of roles) if (!def.roles.includes(r)) problems.push(`${def.label}: this action wasn't built for the ${r} role`);
    }
    if (problems.length) throw new ConfigError(400, 'The permissions could not be saved', problems);
    return mergePermissions(parsed.data);
  },
});

export async function hasPermission(role: string, key: string): Promise<boolean> {
  const def = BY_KEY.get(key);
  if (!def || !def.roles.includes(role as PermRole)) return false;
  if (role === 'BRANCH_HEAD' && !def.branchHeadOptional) return true; // can't be switched off
  return ((await permissionsConfig.get())[key] ?? []).includes(role as PermRole);
}

/** Route guard: like requireRole, but the roles come from Admin → Permissions. */
export function requirePermission(key: string) {
  const def = BY_KEY.get(key);
  if (!def) throw new Error(`Unknown permission ${key}`);
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) { res.status(401).json({ error: 'Not signed in' }); return; }
    try {
      if (await hasPermission(user.role, key)) { next(); return; }
      res.status(403).json({ error: `Your role doesn't have the permission "${def.label}". A Branch Head can change this in Admin → Permissions.` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };
}
