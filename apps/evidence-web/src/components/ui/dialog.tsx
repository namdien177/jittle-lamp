import React from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";

import { cn } from "../../lib/cn";
import { Button } from "./button";

// shadcn/ui Dialog on Base UI primitives.

export const Dialog = BaseDialog.Root;
export const DialogTrigger = BaseDialog.Trigger;
export const DialogPortal = BaseDialog.Portal;
export const DialogClose = BaseDialog.Close;

export function DialogOverlay({ className, ...props }: React.ComponentProps<typeof BaseDialog.Backdrop>): React.JSX.Element {
  return (
    <BaseDialog.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-[900] bg-black/40 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 dark:bg-black/60",
        className
      )}
      {...props}
    />
  );
}

const sizeClass = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl"
} as const;

export type DialogSize = keyof typeof sizeClass;

export function DialogContent({
  className,
  children,
  size = "md",
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof BaseDialog.Popup> & { size?: DialogSize; showCloseButton?: boolean }): React.JSX.Element {
  return (
    <DialogPortal>
      <DialogOverlay />
      <BaseDialog.Viewport className="fixed inset-0 z-[901] grid place-items-center overflow-y-auto p-4 [pointer-events:none] sm:p-6">
        <BaseDialog.Popup
          data-slot="dialog-content"
          className={cn(
            "pointer-events-auto relative flex max-h-[calc(100vh-3rem)] w-full flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-pop outline-none",
            "transition-[opacity,transform] duration-150 ease-[cubic-bezier(.23,1,.32,1)] data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0",
            sizeClass[size],
            className
          )}
          {...props}
        >
          {children}
          {showCloseButton ? (
            <BaseDialog.Close
              data-slot="dialog-close"
              aria-label="Close"
              className="absolute right-3 top-3 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X aria-hidden className="size-4" />
            </BaseDialog.Close>
          ) : null}
        </BaseDialog.Popup>
      </BaseDialog.Viewport>
    </DialogPortal>
  );
}

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div data-slot="dialog-header" className={cn("flex flex-col gap-1 px-5 pb-3 pt-4 pr-12", className)} {...props} />;
}

export function DialogBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div data-slot="dialog-body" className={cn("jl-scroll flex min-h-0 flex-col gap-4 overflow-y-auto px-5 pb-5 pt-1", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-col-reverse gap-2 border-t border-border bg-muted/50 px-5 py-3 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

export function DialogTitle({ className, ...props }: React.ComponentProps<typeof BaseDialog.Title>): React.JSX.Element {
  return <BaseDialog.Title data-slot="dialog-title" className={cn("text-[15px] font-semibold leading-tight", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: React.ComponentProps<typeof BaseDialog.Description>): React.JSX.Element {
  return <BaseDialog.Description data-slot="dialog-description" className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

export type SimpleDialogProps = {
  open?: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: DialogSize;
  closeOnOverlay?: boolean;
};

/** Header + scrolling body + footer, composed from the Dialog parts above. */
export function SimpleDialog(props: SimpleDialogProps): React.JSX.Element | null {
  const { open = true, onClose, title, description, children, footer, size = "md", closeOnOverlay = true } = props;
  if (!open) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      disablePointerDismissal={!closeOnOverlay}
    >
      <DialogContent size={size}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogBody>{children}</DialogBody>
        {footer ? <DialogFooter>{footer}</DialogFooter> : null}
      </DialogContent>
    </Dialog>
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
  const { open, title, description, confirmLabel = "Confirm", cancelLabel = "Cancel", destructive, busy, onConfirm, onCancel } = props;

  return (
    <SimpleDialog
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? "destructive" : "default"} size="sm" onClick={onConfirm} disabled={busy}>
            {busy ? "Working…" : confirmLabel}
          </Button>
        </>
      }
    >
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
    </SimpleDialog>
  );
}
