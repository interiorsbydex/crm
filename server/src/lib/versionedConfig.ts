/**
 * Admin-editable settings saved with a revision number and a change history:
 * load (saved values over defaults), save (refused if someone else saved
 * since the editor was opened), restore the original, and list past versions.
 * Values live in AssignmentConfig under `key`; every save and restore is an
 * activity-log entry (`${action}_UPDATED` / `${action}_RESET`) holding the
 * full value, so any past version can be loaded back into the editor.
 *
 * Used by Automations, Dashboards and Permissions. (Stage Rules and CRM
 * Settings predate it and keep their own equivalent code.)
 */
import type { Router } from 'express';
import { prisma } from './prisma.js';
import { logActivity } from './activityLog.js';

export class ConfigError extends Error {
  constructor(public status: number, message: string, public problems: string[] = []) { super(message); }
}

interface Stored<T> { value: T; revision: number; updatedAt: string; updatedById: string }

export interface VersionedConfigSpec<T> {
  key: string;
  /** e.g. 'AUTOMATIONS' → AUTOMATIONS_UPDATED / AUTOMATIONS_RESET in the activity log. */
  action: string;
  /** What the admin is editing, for messages ("the automations"). */
  noun: string;
  defaults: () => T;
  /** Saved values over the defaults (a section added later starts at its default). */
  merge: (saved: Partial<T> | undefined) => T;
  /** Check and clean a submitted value; throw ConfigError listing problems in plain words. */
  validate: (raw: unknown) => T | Promise<T>;
}

export function versionedConfig<T>(spec: VersionedConfigSpec<T>) {
  const read = async () => (await prisma.assignmentConfig.findUnique({ where: { key: spec.key } }))?.value as Stored<T> | null | undefined;

  return {
    spec,
    async get(): Promise<T> {
      return spec.merge((await read())?.value as Partial<T> | undefined);
    },

    async state() {
      const stored = await read();
      const updatedBy = stored?.updatedById
        ? await prisma.user.findUnique({ where: { id: stored.updatedById }, select: { name: true } })
        : null;
      return {
        value: spec.merge(stored?.value as Partial<T> | undefined),
        defaults: spec.defaults(),
        isDefault: !stored,
        revision: stored?.revision ?? 0,
        updatedAt: stored?.updatedAt ?? null,
        updatedByName: updatedBy?.name ?? null,
      };
    },

    async save(raw: unknown, expectedRevision: unknown, userId: string, note?: string) {
      const value = await spec.validate(raw);
      return prisma.$transaction(async (tx) => {
        const row = await tx.assignmentConfig.findUnique({ where: { key: spec.key } });
        const current = (row?.value as Stored<T> | null)?.revision ?? 0;
        if (expectedRevision !== current) {
          throw new ConfigError(409, `Someone else saved ${spec.noun} since you opened this page. Reload to see their changes, then make yours again.`);
        }
        const stored: Stored<T> = { value, revision: current + 1, updatedAt: new Date().toISOString(), updatedById: userId };
        await tx.assignmentConfig.upsert({
          where: { key: spec.key },
          create: { key: spec.key, value: stored as any },
          update: { value: stored as any },
        });
        await tx.activityLog.create({
          data: { userId, action: `${spec.action}_UPDATED`, meta: { revision: stored.revision, value, ...(note && { note: note.slice(0, 300) }) } as any },
        });
        return stored;
      });
    },

    async reset(userId: string) {
      await prisma.assignmentConfig.deleteMany({ where: { key: spec.key } });
      await logActivity(userId, `${spec.action}_RESET`, undefined, { value: spec.defaults() });
    },

    async history(limit = 30) {
      const rows = await prisma.activityLog.findMany({
        where: { action: { in: [`${spec.action}_UPDATED`, `${spec.action}_RESET`] }, leadId: null },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, action: true, createdAt: true, meta: true, user: { select: { name: true } } },
      });
      return rows.map((r) => {
        const meta = (r.meta ?? {}) as { revision?: number; note?: string; value?: T };
        return {
          id: r.id, reset: r.action.endsWith('_RESET'), createdAt: r.createdAt, byName: r.user?.name ?? 'Unknown',
          revision: meta.revision ?? null, note: meta.note ?? null, value: meta.value ?? null,
        };
      });
    },
  };
}

export type VersionedConfig<T> = ReturnType<typeof versionedConfig<T>>;

/**
 * GET / PUT / DELETE `${path}` and GET `${path}/history` on an admin router
 * (which already requires the Branch Head role). `extra` adds fields to the GET
 * response, e.g. a catalogue of choices for the editor.
 */
export function mountVersionedConfig<T>(router: Router, path: string, config: VersionedConfig<T>, extra: () => Promise<Record<string, unknown>> = async () => ({})) {
  const fail = (res: any, err: any) => {
    if (err instanceof ConfigError) res.status(err.status).json({ error: err.message, problems: err.problems });
    else res.status(500).json({ error: err.message });
  };
  router.get(path, async (_req, res) => {
    try { res.json({ ...(await config.state()), ...(await extra()) }); } catch (err) { fail(res, err); }
  });
  router.put(path, async (req, res) => {
    try {
      const { value, revision, note } = req.body as { value?: unknown; revision?: unknown; note?: string };
      const saved = await config.save(value, revision, req.user!.id, typeof note === 'string' ? note : undefined);
      res.json({ revision: saved.revision, updatedAt: saved.updatedAt, value: saved.value });
    } catch (err) { fail(res, err); }
  });
  router.get(`${path}/history`, async (_req, res) => {
    try { res.json({ history: await config.history() }); } catch (err) { fail(res, err); }
  });
  router.delete(path, async (req, res) => {
    try { await config.reset(req.user!.id); res.json(await config.state()); } catch (err) { fail(res, err); }
  });
}

/** Turn zod issues into plain-words problems, naming sections by `names`. */
/** The validator's built-in messages in everyday words (custom messages pass through). */
export function plainMessage(message: string): string {
  return message
    .replace(/^Number must be greater than or equal to (-?[\d.]+)$/, 'must be at least $1')
    .replace(/^Number must be greater than (-?[\d.]+)$/, 'must be more than $1')
    .replace(/^Number must be less than or equal to (-?[\d.]+)$/, 'must be $1 or less')
    .replace(/^Number must be less than (-?[\d.]+)$/, 'must be less than $1')
    .replace(/^Expected integer, received float$/, 'must be a whole number')
    .replace(/^Expected number, received (string|nan|null|undefined)$/, 'needs a number')
    .replace(/^Required$/, 'is missing')
    .replace(/^String must contain at least 1 character\(s\)$/, 'cannot be empty')
    .replace(/^String must contain at most (\d+) character\(s\)$/, 'is limited to $1 characters')
    .replace(/^Array must contain at most (\d+) element\(s\)$/, 'can have at most $1 entries')
    .replace(/^Array must contain at least (\d+) element\(s\)$/, 'needs at least $1 entries');
}

export function describeIssues(issues: { path: (string | number)[]; message: string }[], names: Record<string, string> = {}): string[] {
  return issues.map((i) => {
    const [section, ...rest] = i.path;
    const where = names[String(section)] ?? String(section ?? 'Settings');
    return `${where}${rest.length ? ` (${rest.join(' → ')})` : ''}: ${plainMessage(i.message)}`;
  });
}
