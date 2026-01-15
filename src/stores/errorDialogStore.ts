import { create } from "zustand";

export interface ErrorDetails {
  title: string;
  message: string;
  timestamp: Date;
}

interface ErrorDialogState {
  /** Currently displayed error, or null if dialog is closed */
  error: ErrorDetails | null;

  /** Show the error details dialog */
  showError: (title: string, message: string) => void;

  /** Close the error details dialog */
  closeError: () => void;
}

export const useErrorDialogStore = create<ErrorDialogState>()((set) => ({
  error: null,

  showError: (title, message) =>
    set({
      error: {
        title,
        message,
        timestamp: new Date(),
      },
    }),

  closeError: () => set({ error: null }),
}));
