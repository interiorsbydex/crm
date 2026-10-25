import { useCallback, useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { api } from '../lib/api';
import NotificationList, { type NotifItem } from '../components/NotificationList';

export default function Notifications() {
  const [notifs, setNotifs] = useState<NotifItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ unreadCount: number; notifications: NotifItem[]; hasMore: boolean }>('/notifications/my');
      setNotifs(data.notifications ?? []);
      setUnreadCount(data.unreadCount ?? 0);
      setHasMore(data.hasMore ?? false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadMore = useCallback(async () => {
    if (notifs.length === 0) return;
    setLoadingMore(true);
    try {
      const cursor = notifs[notifs.length - 1].id;
      const data = await api.get<{ notifications: NotifItem[]; hasMore: boolean }>(
        `/notifications/my?cursor=${encodeURIComponent(cursor)}`,
      );
      setNotifs((prev) => [...prev, ...(data.notifications ?? [])]);
      setHasMore(data.hasMore ?? false);
    } finally {
      setLoadingMore(false);
    }
  }, [notifs]);

  const handleMarkRead = useCallback((id: string) => {
    setNotifs((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
    setUnreadCount((c) => Math.max(0, c - 1));
    api.patch(`/notifications/${id}/read`).catch(() => {
      setNotifs((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: false } : n)));
      setUnreadCount((c) => c + 1);
    });
  }, []);

  const handleMarkAllRead = async () => {
    setNotifs((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnreadCount(0);
    try {
      await api.patch('/notifications/read-all');
    } catch {
      load();
    }
  };

  return (
    <div className="max-w-2xl mx-auto py-8 px-4">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Bell size={20} strokeWidth={1.8} className="text-stone-700" />
          <h1 className="text-xl font-bold text-stone-900">Notifications</h1>
          {unreadCount > 0 && (
            <span className="text-xs text-brand-600 font-medium bg-brand-50 rounded-full px-2 py-0.5">{unreadCount} unread</span>
          )}
        </div>
        {unreadCount > 0 && (
          <button
            onClick={handleMarkAllRead}
            className="text-xs font-medium text-brand-600 hover:text-brand-700"
          >
            Mark all as read
          </button>
        )}
      </div>

      <div className="bg-white rounded-2xl shadow-sm overflow-hidden" style={{ border: '1px solid #EDE8E3' }}>
        {loading ? (
          <p className="text-center text-sm text-stone-400 py-10">Loading…</p>
        ) : (
          <NotificationList notifications={notifs} onMarkRead={handleMarkRead} variant="full" />
        )}
        {!loading && hasMore && (
          <div className="py-3 text-center border-t border-stone-100">
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="text-xs font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50"
            >
              {loadingMore ? 'Loading…' : 'Load older notifications'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
