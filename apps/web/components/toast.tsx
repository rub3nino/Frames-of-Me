"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

type ToastItem = { id: number; message: string; leaving: boolean };

const ToastContext = createContext<(message: string) => void>(() => {});

export function useToast(): (message: string) => void {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const push = useCallback((message: string) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((current) => [...current, { id, message, leaving: false }]);
    window.setTimeout(() => {
      setToasts((current) =>
        current.map((item) => (item.id === id ? { ...item, leaving: true } : item)),
      );
      window.setTimeout(() => {
        setToasts((current) => current.filter((item) => item.id !== id));
      }, 260);
    }, 3200);
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toaster" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className="toast" data-leaving={toast.leaving ? "true" : "false"} role="status">
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
