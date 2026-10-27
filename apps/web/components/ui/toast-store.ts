import type { FeedbackTone } from "@web/components/ui/feedback";
import { createStore } from "zustand/vanilla";

interface ToastInput {
  title?: string;
  message: string;
  tone?: FeedbackTone;
}

export interface ToastStore {
  toast: (ToastInput & { id: number; tone: FeedbackTone }) | undefined;
  showToast: (input: ToastInput) => number;
  dismissToast: (id: number) => void;
}

export const createToastStore = () => {
  let nextId = 0;

  return createStore<ToastStore>((set) => ({
    toast: undefined,
    showToast: (input) => {
      const id = ++nextId;
      set({ toast: { ...input, id, tone: input.tone ?? "info" } });
      return id;
    },
    dismissToast: (id) => {
      set((state) => (state.toast?.id === id ? { toast: undefined } : state));
    },
  }));
};
