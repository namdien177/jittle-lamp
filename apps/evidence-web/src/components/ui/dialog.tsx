import React from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";

import { cn } from "../../lib/cn";
import { Button } from "./button";

const sizeClass: Record<"sm" | "md" | "lg" | "xl", string> = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl"
};

export type DialogProps = {
  open?: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  closeOnOverlay?: boolean;
};

export function Dialog(props: DialogProps): React.JSX.Element | null {
  const {
    open = true,
    onClose,
    title,
    description,
    children,
    footer,
    size = "md",
    closeOnOverlay = true
  } = props;

  if (!open) return null;

  return (
    <BaseDialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      disablePointerDismissal={!closeOnOverlay}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-[900] bg-black/65 backdrop-blur-sm transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <BaseDialog.Viewport className="fixed inset-0 z-[901] grid place-items-center overflow-y-auto p-4 sm:p-6 [pointer-events:none]">
          <BaseDialog.Popup
            className={cn(
              "pointer-events-auto flex w-full flex-col overflow-hidden rounded-xl border border-border-strong bg-card text-card-foreground shadow-pop",
              "max-h-[calc(100vh-3rem)] transition-[opacity,transform] duration-150",
              "data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0",
              "data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0",
              sizeClass[size]
            )}
          >
            <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
              <div className="space-y-1">
                <BaseDialog.Title className="font-display text-base font-semibold tracking-tight">
                  {title}
                </BaseDialog.Title>
                {description ? (
                  <BaseDialog.Description className="text-sm text-muted-foreground">
                    {description}
                  </BaseDialog.Description>
                ) : null}
              </div>
              <BaseDialog.Close
                className="-mr-1.5 -mt-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
                aria-label="Close"
              >
                <X aria-hidden className="size-4" strokeWidth={2} />
              </BaseDialog.Close>
            </div>
            <div className="jl-scroll flex flex-col gap-4 overflow-y-auto px-5 py-5">{children}</div>
            {footer ? (
              <div className="flex justify-end gap-2 border-t border-border bg-black/20 px-5 py-3.5">
                {footer}
              </div>
            ) : null}
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

export type ConfirmDialogProps = {
  open: boolean;
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog(props: ConfirmDialogProps): React.JSX.Element | null {
  const {
    open,
    title,
    description,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    destructive,
    busy,
    onConfirm,
    onCancel
  } = props;

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "destructive" : "primary"}
            size="sm"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">{description}</p>
    </Dialog>
  );
}
