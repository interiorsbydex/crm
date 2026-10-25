import toast from 'react-hot-toast';
const BASE = '/api';

function getToken() {
  return localStorage.getItem('crm_token');
}

function getRefreshToken() {
  return localStorage.getItem('crm_refresh_token');
}

function clearSession() {
  localStorage.removeItem('crm_token');
  localStorage.removeItem('crm_refresh_token');
  localStorage.removeItem('crm_user');
}

let refreshInFlight: Promise<string | null> | null = null;
let proactiveRefreshTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Decodes the JWT `exp` claim and schedules a proactive token refresh
 * 5 minutes before expiry, so active sessions never hit a mid-action 401.
 * Re-arms itself with the newly issued token each time it fires.
 * Call this immediately after storing a new access token (login or refresh).
 */
export function scheduleProactiveRefresh(token: string): void {
  if (proactiveRefreshTimer !== null) {
    clearTimeout(proactiveRefreshTimer);
    proactiveRefreshTimer = null;
  }
  try {
    const parts = token.split('.');
    if (parts.length < 2) return;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    if (!payload.exp) return;
    const delayMs = payload.exp * 1000 - Date.now() - 5 * 60 * 1000; // fire 5 min before expiry
    if (delayMs < 30_000) return; // already too close — let the 401 retry path handle it
    proactiveRefreshTimer = setTimeout(async () => {
      proactiveRefreshTimer = null;
      const newToken = await refreshAccessToken();
      if (newToken) scheduleProactiveRefresh(newToken); // re-arm for the fresh token
    }, delayMs);
  } catch {
    // Malformed token — silently skip; 401 retry path will handle expiry
  }
}

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;

  if (!refreshInFlight) {
    refreshInFlight = fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
      .then(async (res) => {
        if (!res.ok) return null;
        const data = await res.json() as { accessToken?: string; refreshToken?: string };
        if (!data.accessToken) return null;
        localStorage.setItem('crm_token', data.accessToken);
        if (data.refreshToken) localStorage.setItem('crm_refresh_token', data.refreshToken);
        scheduleProactiveRefresh(data.accessToken); // re-arm for the refreshed token
        return data.accessToken;
      })
      .catch(() => null)
      .finally(() => {
        refreshInFlight = null;
      });
  }

  return refreshInFlight;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  let token = getToken();
  // The bounded retry loop always runs once; a failed fetch throws.
  let res!: Response;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    res = await fetch(`${BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });

    if (res.status !== 401 || attempt > 0 || path === '/auth/refresh') break;
    token = await refreshAccessToken();
    if (!token) break;
  }

  if (!res.ok) {
    if (res.status === 401) {
      clearSession();
      window.location.href = '/login';
      throw new Error('Session expired — please sign in again');
    }
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const base = err.error ?? `HTTP ${res.status}`;
    const msg = Array.isArray(err.missing) && err.missing.length
      ? `${base} — missing: ${err.missing.join(', ')}`
      : base;
    // The full response body rides along (e.g. a `problems` list from admin forms).
    throw Object.assign(new Error(msg), { status: res.status, data: err });
  }

  const data = await res.json();
  // Emails set to "send straight away" (Admin → Automations) went out without a review screen.
  if (Array.isArray(data?.autoSent) && data.autoSent.length) {
    toast.success(`Email sent to ${Array.from(new Set(data.autoSent.map((m: { to: string }) => m.to))).join(', ')}`);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body !== undefined ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body !== undefined ? JSON.stringify(body) : undefined }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// ── File upload helper ─────────────────────────────────────────────────────────
export async function uploadFile<T>(path: string, formData: FormData): Promise<T> {
  let token = getToken();
  // The bounded retry loop always runs once; a failed fetch throws.
  let res!: Response;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
    if (res.status !== 401 || attempt > 0) break;
    token = await refreshAccessToken();
    if (!token) break;
  }

  if (!res.ok) {
    if (res.status === 401) {
      clearSession();
      window.location.href = '/login';
      throw new Error('Session expired — please sign in again');
    }
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NextPlanItem {
  kind: 'CALL' | 'MEETING' | 'TASK';
  sendExternalMail?: boolean;
  dueDate?: string;
  dueTime?: string;
  timeFrom?: string;
  timeTo?: string;
  taskType?: 'INTERNAL' | 'EXTERNAL';
  agenda?: string;
  meetingType?: string;
  mode?: string;
  scheduledAt?: string;
  location?: string;
  notes?: string;
}

export interface CallRecord {
  id: string;
  outcome: string;
  duration?: number;
  notes?: string;
  recordingUrl?: string | null;
  agenda?: string;
  location?: string;
  calledAt?: string;
  attachments?: { type: string; fileUrl?: string }[];
  nextPlanOfAction?: string;
  nextPlanOfActionItems?: NextPlanItem[];
  createdAt: string;
  loggedBy: { id: string; name: string; role: string };
}

export interface FollowUpTask {
  id: string;
  leadId: string;
  dueDate: string;
  dueTime?: string;
  timeFrom?: string;
  timeTo?: string;
  isCompleted: boolean;
  isOverdue: boolean;
  status: 'PENDING' | 'COMPLETED' | 'RESCHEDULED' | 'NOT_DONE';
  outcome?: string;
  taskType?: 'INTERNAL' | 'EXTERNAL';
  agenda?: string;
  internalNotes?: string;
  rescheduleHistory?: { dueDate: string; dueTime?: string; reason: string; rescheduledAt: string }[];
  attachments?: { type: string; fileUrl?: string; fileName?: string }[];
  completedAt?: string;
  createdAt: string;
  assignedTo: { id: string; name: string; role: string };
  lead?: { id: string; leadId: string; name: string; stage: string };
  /// Marks a scheduled-but-not-yet-made call (including callbacks) rather
  /// than a generic follow-up task.
  callStageType?: string;
}

export interface Meeting {
  id: string;
  type: 'DQL' | 'PP' | 'PD' | 'ONBOARDING' | 'OBM' | 'DESIGN_FREEZE' | 'SIGN_OFF';
  ppNumber?: number;
  seqNumber?: number;
  mode: string;
  status: string;
  scheduledAt: string;
  rescheduledReason?: string;
  rescheduleMode?: string;
  rescheduleLocation?: string;
  noShowReason?: string;
  replanScheduledAt?: string;
  replanMode?: string;
  replanLocation?: string;
  location?: string;
  rescheduleHistory?: { scheduledAt: string; reason: string; rescheduledAt: string }[];
  mom?: string;
  momAttachmentTypes?: string[];
  momAttachments?: { type: string; fileUrl?: string; storagePath?: string }[];
  nextPlanOfActionItems?: NextPlanItem[];
  outcome?: string;
  internalNotes?: string;
  confirmationSent: boolean;
  momSent: boolean;
  createdAt: string;
}

export interface Notification {
  id: string;
  type: string;
  message: string;
  leadId?: string;
  isRead: boolean;
  createdAt: string;
  lead?: { id: string; leadId: string; name: string };
}
