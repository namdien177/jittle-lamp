import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

export type ToastTone = "neutral" | "success" | "error" | "warning";

export type Toast = {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
  durationMs: number;
  action?: { label: string; onClick: () => void };
};

type ToastInput = Omit<Toast, "id" | "tone" | "durationMs"> & {
  tone?: ToastTone;
  durationMs?: number;
};

type ToastApi = {
  toast: (input: ToastInput) => string;
  success: (title: string, description?: string) => string;
  error: (title: string, description?: string) => string;
  info: (title: string, description?: string) => string;
  warning: (title: string, description?: string) => string;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_DURATION = 4500;

export function ToastProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [items, setItems] = useState<Toast[]>([]);
  const timeoutsRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const handle = timeoutsRef.current.get(id);
    if (handle) {
      clearTimeout(handle);
      timeoutsRef.current.delete(id);
    }
    setItems((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (input: ToastInput): string => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const toast: Toast = {
        id,
        title: input.title,
        ...(input.description !== undefined ? { description: input.description } : {}),
        tone: input.tone ?? "neutral",
        durationMs: input.durationMs ?? DEFAULT_DURATION,
        ...(input.action ? { action: input.action } : {})
      };
      setItems((prev) => [...prev, toast]);
      if (toast.durationMs > 0) {
        const handle = setTimeout(() => dismiss(id), toast.durationMs);
        timeoutsRef.current.set(id, handle);
      }
      return id;
    },
    [dismiss]
  );

  const api = useMemo<ToastApi>(
    () => ({
      toast: push,
      success: (title, description) => push({ title, ...(description ? { description } : {}), tone: "success" }),
      error: (title, description) =>
        push({ title, ...(description ? { description } : {}), tone: "error", durationMs: 6500 }),
      info: (title, description) => push({ title, ...(description ? { description } : {}), tone: "neutral" }),
      warning: (title, description) => push({ title, ...(description ? { description } : {}), tone: "warning" }),
      dismiss
    }),
    [push, dismiss]
  );

  useEffect(() => {
    const handles = timeoutsRef.current;
    return () => {
      for (const handle of handles.values()) {
        clearTimeout(handle);
      }
      handles.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-viewport" role="region" aria-live="polite">
        {items.map((toast) => (
          <div key={toast.id} className="toast" data-tone={toast.tone} role="status">
            <div className="toast-body">
              <span className="toast-title">{toast.title}</span>
              {toast.description ? <span className="toast-description">{toast.description}</span> : null}
            </div>
            <div className="toast-actions">
              {toast.action ? (
                <button
                  className="button ghost xs"
                  type="button"
                  onClick={() => {
                    toast.action?.onClick();
                    dismiss(toast.id);
                  }}
                >
                  {toast.action.label}
                </button>
              ) : null}
              <button className="toast-dismiss" type="button" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
                <X aria-hidden size={14} strokeWidth={2} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}
