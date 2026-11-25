import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, clearToken, getToken, setToken } from './api';
import type { User } from './types';

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  setup: (username: string, password: string) => Promise<void>;
  loginWithToken: (token: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState>(null as unknown as AuthState);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) { setLoading(false); return; }
    api.me()
      .then((r) => setUser({ id: r.user.userId, username: r.user.username, role: r.user.role }))
      .catch(() => clearToken())
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (u: string, p: string) => {
    const r = await api.login(u, p); setToken(r.token); setUser(r.user);
  }, []);
  const setup = useCallback(async (u: string, p: string) => {
    const r = await api.setup(u, p); setToken(r.token); setUser(r.user);
  }, []);
  const loginWithToken = useCallback(async (token: string) => {
    setToken(token);
    const r = await api.me();
    setUser({ id: r.user.userId, username: r.user.username, role: r.user.role });
  }, []);
  const logout = useCallback(() => { clearToken(); setUser(null); }, []);

  const value = useMemo(() => ({ user, loading, login, setup, loginWithToken, logout }), [user, loading, login, setup, loginWithToken, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
