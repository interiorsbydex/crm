import { Children, Fragment, isValidElement, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { api } from './api';
import { DASHBOARD_TILES } from './dashboardTiles';

/**
 * Admin → Dashboards (server: lib/dashboardLayouts.ts): per dashboard, hidden
 * tiles, tile order within each section and renamed tile titles.
 *
 * Each dashboard section is a <TileGroup>, each tile a <Tile id=…>; the group
 * drops hidden tiles and orders the rest. Titles go through
 * useDashboardLayout(dashboard).label(id, original).
 */
export interface DashboardLayout { order: string[]; hidden: string[]; labels: Record<string, string> }
export type DashboardLayouts = Record<string, DashboardLayout>;

const EMPTY: DashboardLayout = { order: [], hidden: [], labels: {} };
let current: DashboardLayouts = {};
let loaded = false;
let inflight: Promise<DashboardLayouts> | null = null;
const listeners = new Set<(l: DashboardLayouts) => void>();

export function loadDashboardLayouts(force = false): Promise<DashboardLayouts> {
  if (loaded && !force) return Promise.resolve(current);
  if (!inflight) {
    inflight = api.get<{ layouts: DashboardLayouts }>('/config/dashboards')
      .then(({ layouts }) => {
        current = layouts;
        loaded = true;
        listeners.forEach((fn) => fn(layouts));
        return layouts;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

export function useDashboardLayout(dashboard: string) {
  const [layouts, setLayouts] = useState(current);
  useEffect(() => {
    listeners.add(setLayouts);
    if (!loaded) loadDashboardLayouts().catch(() => {});
    else setLayouts(current);
    return () => { listeners.delete(setLayouts); };
  }, []);
  const layout = layouts[dashboard] ?? EMPTY;
  return {
    layout,
    /** The tile's title: renamed by the admin, else `original`. */
    label: (id: string, original: string) => layout.labels[id] ?? original,
    shown: (id: string) => !layout.hidden.includes(id),
  };
}

/** Marks one tile inside a <TileGroup>. Renders its children unchanged. */
export function Tile({ id, children }: { id: string; children: ReactNode }) {
  if (import.meta.env.DEV && !DASHBOARD_TILES.some((t) => t.id === id)) {
    console.warn(`[dashboards] Tile "${id}" is missing from lib/dashboardTiles.ts, so it can't be configured.`);
  }
  return <>{children}</>;
}

/**
 * One dashboard section: shows its <Tile>s in the admin's order (tiles not
 * yet ordered keep their original place after the ordered ones), without the
 * hidden ones. Renders nothing when every tile is hidden.
 */
export function TileGroup({ dashboard, className, children }: { dashboard: string; className?: string; children: ReactNode }) {
  const { layout } = useDashboardLayout(dashboard);
  const flat: ReactElement[] = [];
  const collect = (nodes: ReactNode) => Children.forEach(nodes, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === Fragment) collect((child.props as { children?: ReactNode }).children);
    else flat.push(child);
  });
  collect(children);
  const idOf = (el: ReactElement) => (el.type === Tile ? (el.props as { id: string }).id : null);
  const visible = flat.filter((el) => { const id = idOf(el); return !id || !layout.hidden.includes(id); });
  const rank = (el: ReactElement, i: number) => {
    const id = idOf(el);
    const pos = id ? layout.order.indexOf(id) : -1;
    return pos === -1 ? layout.order.length + i : pos;
  };
  const sorted = visible.map((el, i) => ({ el, r: rank(el, i) })).sort((a, b) => a.r - b.r).map((x) => x.el);
  if (!sorted.length) return null;
  return <div className={className}>{sorted.map((el, i) => <Fragment key={idOf(el) ?? i}>{el}</Fragment>)}</div>;
}

/**
 * The tabs of a report block as the admin set them: hidden ones dropped, the rest in the admin's order and with their
 * chosen names. `block` is hidden entirely when the admin hid it or hid every tab.
 */
export function useReportTabs<T extends { key: string; label: string }>(
  blockId: string, tabIdOf: (key: string) => string, tabs: T[], defaultHeading: string,
) {
  const { layout, label } = useDashboardLayout('reports');
  const rank = (t: T, i: number) => { const pos = layout.order.indexOf(tabIdOf(t.key)); return pos === -1 ? layout.order.length + i : pos; };
  const visible = tabs
    .map((t, i) => ({ t, r: rank(t, i) }))
    .filter(({ t }) => !layout.hidden.includes(tabIdOf(t.key)))
    .sort((a, b) => a.r - b.r)
    .map(({ t }) => ({ ...t, label: label(tabIdOf(t.key), t.label) }));
  return { visible, blockHidden: layout.hidden.includes(blockId) || visible.length === 0, heading: label(blockId, defaultHeading) };
}
