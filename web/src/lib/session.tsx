import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type Household, type User } from './api';

type SessionValue = {
  user: User | null;
  household: Household | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [household, setHousehold] = useState<Household | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api.me();
      setUser(data.user);
      setHousehold(data.household);
    } catch {
      setUser(null);
      setHousehold(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await api.logout();
    setUser(null);
    setHousehold(null);
  }, []);

  const value = useMemo(
    () => ({ user, household, loading, refresh, signOut }),
    [user, household, loading, refresh, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession debe usarse dentro de SessionProvider');
  return value;
}

/** Moneda del hogar, con CLP como valor por defecto. */
export function useCurrency(): string {
  return useSession().household?.currency ?? 'CLP';
}
