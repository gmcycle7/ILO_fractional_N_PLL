/**
 * Global simulation status: chapters report simulation progress here and the
 * top bar displays it. Usage inside a chapter:
 *
 *   const { setStatus } = useSimStatus();
 *   setStatus('running', 'sweep N = 3.000 … 3.250');
 *   ... compute ...
 *   setStatus('done', '512 cycles');
 */

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type SimStatus = 'idle' | 'running' | 'done';

export interface SimStatusContextValue {
  status: SimStatus;
  message: string;
  setStatus: (status: SimStatus, message?: string) => void;
}

export const SimStatusContext = createContext<SimStatusContextValue>({
  status: 'idle',
  message: '',
  setStatus: () => undefined,
});

export function SimStatusProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ status: SimStatus; message: string }>({
    status: 'idle',
    message: '',
  });
  const setStatus = useCallback((status: SimStatus, message = '') => {
    setState({ status, message });
  }, []);
  const value = useMemo<SimStatusContextValue>(
    () => ({ status: state.status, message: state.message, setStatus }),
    [state, setStatus],
  );
  return <SimStatusContext.Provider value={value}>{children}</SimStatusContext.Provider>;
}

export function useSimStatus(): SimStatusContextValue {
  return useContext(SimStatusContext);
}
