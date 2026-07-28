'use client';
import { createContext, useContext, useCallback, useState } from 'react';

type ToastType = 'success' | 'error' | 'info';
interface ToastItem { id: number; message: string; type: ToastType; }
interface Ctx { notify: (message: string, type?: ToastType) => void; }

const ToastContext = createContext<Ctx>({ notify: () => {} });
export const useToast = () => useContext(ToastContext);

let seq = 0;
const colors: Record<ToastType, string> = {
  success: 'bg-green-600',
  error: 'bg-red-600',
  info: 'bg-slate-800',
};

export default function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const notify = useCallback((message: string, type: ToastType = 'success') => {
    const id = ++seq;
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);
  return (
    <ToastContext.Provider value={{ notify }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={`${colors[t.type]} rounded-lg px-4 py-3 text-sm text-white shadow-lg`}>{t.message}</div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
