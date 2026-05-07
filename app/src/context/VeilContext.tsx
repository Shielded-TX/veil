import { createContext, useContext, type ReactNode } from 'react';
import { useVeil, type VeilHook } from '../hooks/useVeil';

const VeilContext = createContext<VeilHook | null>(null);

export function VeilProvider({ children }: { children: ReactNode }) {
    const veil = useVeil();
    return <VeilContext.Provider value={veil}>{children}</VeilContext.Provider>;
}

export function useVeilContext(): VeilHook {
    const ctx = useContext(VeilContext);
    if (!ctx) throw new Error('useVeilContext must be used inside <VeilProvider>');
    return ctx;
}
