import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";

import { Button } from "./components/ui/button";
import { cn } from "./lib/cn";

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

const toneIcon = { neutral: Info, success: CheckCircle2, error: XCircle, warning: AlertTriangle } as const;
const toneClass = { neutral: "text-muted-foreground", success: "text-primary", error: "text-destructive", warning: "text-warning" } as const;

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
      <div className="pointer-events-none fixed bottom-4 right-4 z-[1100] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2" role="region" aria-live="polite">
        {items.map((toast) => {
          const Icon = toneIcon[toast.tone];
          return (
            <div
              key={toast.id}
              data-tone={toast.tone}
              role="status"
              className="pointer-events-auto flex animate-rise items-start gap-2.5 rounded-lg border border-border bg-popover px-3 py-2.5 text-popover-foreground shadow-pop"
            >
              <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", toneClass[toast.tone])} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-snug">{toast.title}</p>
                {toast.description ? <p className="mt-0.5 break-words text-xs text-muted-foreground">{toast.description}</p> : null}
              </div>
              {toast.action ? (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    toast.action?.onClick();
                    dismiss(toast.id);
                  }}
                >
                  {toast.action.label}
                </Button>
              ) : null}
              <button type="button" aria-label="Dismiss" className="-mr-1 grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => dismiss(toast.id)}>
                <X aria-hidden className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}
