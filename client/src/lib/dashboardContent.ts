import { api } from './api';

export type DashboardContentKind = 'ANNOUNCEMENT' | 'INSPIRATION';
export interface DashboardContentDraft {
  kind: DashboardContentKind;
  title: string;
  body: string;
  imageUrl: string | null;
  linkUrl: string | null;
}
export interface DashboardContentItem extends DashboardContentDraft {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export const dashboardContentApi = {
  list: () => api.get<{ items: DashboardContentItem[] }>('/dashboard-content'),
  adminList: () => api.get<{ items: DashboardContentItem[] }>('/admin/dashboard-content'),
  create: (draft: DashboardContentDraft) =>
    api.post<{ item: DashboardContentItem }>('/admin/dashboard-content', draft),
  update: (item: DashboardContentItem, draft: DashboardContentDraft) =>
    api.put<{ item: DashboardContentItem }>(`/admin/dashboard-content/${encodeURIComponent(item.id)}`, {
      ...draft, revision: item.revision,
    }),
  remove: (item: DashboardContentItem) =>
    api.delete<{ deleted: boolean }>(`/admin/dashboard-content/${encodeURIComponent(item.id)}?revision=${item.revision}`),
};
