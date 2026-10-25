export function getStoredUser(): { id: string; name: string; email: string; role: string } | null {
  try {
    const raw = localStorage.getItem('crm_user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function logout() {
  localStorage.removeItem('crm_token');
  localStorage.removeItem('crm_refresh_token');
  localStorage.removeItem('crm_user');
  window.location.href = '/login';
}
