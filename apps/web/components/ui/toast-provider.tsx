"use client";

import { Feedback } from "@web/components/ui/feedback";
import {
  createToastStore,
  type ToastStore,
} from "@web/components/ui/toast-store";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { useStore } from "zustand";

const ToastStoreContext = createContext<ReturnType<
  typeof createToastStore
> | null>(null);

export const useToastStore = <T,>(selector: (state: ToastStore) => T): T => {
  const store = useContext(ToastStoreContext);
  if (!store) throw new Error("useToastStore requires ToastProvider");
  return useStore(store, selector);
};

const ToastViewport = () => {
  const toast = useToastStore((state) => state.toast);
  const dismissToast = useToastStore((state) => state.dismissToast);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => dismissToast(toast.id), 3_200);
    return () => window.clearTimeout(timer);
  }, [toast, dismissToast]);

  if (!toast) return null;

  return (
    <div className="pointer-events-none fixed top-6 right-6 z-50 w-85.5 max-w-[calc(100vw-48px)]">
      <Feedback
        key={toast.id}
        kind="toast"
        tone={toast.tone}
        title={toast.title ?? ""}
        className="pointer-events-auto animate-toast-dismiss"
        onDismiss={() => dismissToast(toast.id)}
      >
        {toast.message}
      </Feedback>
    </div>
  );
};

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [store] = useState(createToastStore);

  return (
    <ToastStoreContext.Provider value={store}>
      {children}
      <ToastViewport />
    </ToastStoreContext.Provider>
  );
};
