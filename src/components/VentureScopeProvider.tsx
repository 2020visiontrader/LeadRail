'use client';
import { createContext, useContext, useEffect, useState, useCallback } from 'react';

// The single source of truth for "which venture is selected" — was local
// `useState` in app/page.tsx and existed nowhere else, so nothing persisted
// it and no other page could read it. A venture chosen on the dashboard did
// not stay selected on /assistant, and /assistant had no id to send at all
// — see AgentConsole/CommandBar for what that cost the agent's context.
//
// 'all' means no venture is selected (every venture in scope). Exported so
// every reader compares against the same sentinel rather than each page
// inventing its own 'all'/''/undefined convention.
export const ALL_VENTURES = 'all';

interface Ctx {
  /** The selected venture id, or ALL_VENTURES. */
  scopeId: string;
  setScopeId: (id: string) => void;
}

const STORAGE_KEY = 'leadrail:ventureScope';

const VentureScopeContext = createContext<Ctx>({ scopeId: ALL_VENTURES, setScopeId: () => {} });
export const useVentureScope = () => useContext(VentureScopeContext);

export default function VentureScopeProvider({ children }: { children: React.ReactNode }) {
  // Starts at ALL_VENTURES on every render (server and first client render
  // must match, or React complains about a hydration mismatch) and is
  // corrected from localStorage in an effect immediately after mount — the
  // same one-render flash every localStorage-backed value in this app
  // accepts (see the theme init script in app/layout.tsx for the same trade,
  // done inline there only because it must run before paint).
  const [scopeId, setScopeIdState] = useState<string>(ALL_VENTURES);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setScopeIdState(saved);
    } catch { /* private browsing, storage disabled — fall back to ALL_VENTURES */ }
  }, []);

  const setScopeId = useCallback((id: string) => {
    setScopeIdState(id);
    try {
      if (id && id !== ALL_VENTURES) localStorage.setItem(STORAGE_KEY, id);
      else localStorage.removeItem(STORAGE_KEY);
    } catch { /* best-effort — the in-memory value above still updates */ }
  }, []);

  return (
    <VentureScopeContext.Provider value={{ scopeId, setScopeId }}>
      {children}
    </VentureScopeContext.Provider>
  );
}
