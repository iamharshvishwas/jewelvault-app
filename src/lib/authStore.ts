'use client';

export type AuthRole = 'Admin' | 'Staff';

export interface AuthSession {
  username: string;
  displayName: string;
  role: AuthRole;
}

const SESSION_KEY = 'jaishri.auth.session.v1';

const USERS: Record<string, { password: string; displayName: string; role: AuthRole }> = {
  admin: { password: 'admin123', displayName: 'Jaishri Admin', role: 'Admin' },
  staff: { password: 'staff123', displayName: 'Inventory Staff', role: 'Staff' },
};

export const STAFF_ALLOWED_PATHS = [
  '/',
  '/inventory-management',
  '/add-design',
  '/edit-stock',
  '/print-tags',
  '/catalogue',
  '/design-detail',
];

function canUseStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function getSession(): AuthSession | null {
  if (!canUseStorage()) return null;
  const saved = window.localStorage.getItem(SESSION_KEY);
  if (!saved) return null;
  try {
    const parsed = JSON.parse(saved) as AuthSession;
    return parsed.role === 'Admin' || parsed.role === 'Staff' ? parsed : null;
  } catch {
    return null;
  }
}

export function signIn(username: string, password: string): AuthSession | null {
  const user = USERS[username.trim().toLowerCase()];
  if (!user || user.password !== password) return null;
  const session: AuthSession = {
    username: username.trim().toLowerCase(),
    displayName: user.displayName,
    role: user.role,
  };
  if (canUseStorage()) window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function signOut() {
  if (canUseStorage()) window.localStorage.removeItem(SESSION_KEY);
}

export function canAccessPath(role: AuthRole, pathname: string) {
  if (role === 'Admin') return true;
  return STAFF_ALLOWED_PATHS.some((path) => (path === '/' ? pathname === '/' : pathname.startsWith(path)));
}
