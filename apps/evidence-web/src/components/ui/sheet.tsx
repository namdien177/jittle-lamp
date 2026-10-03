import React from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";

import { cn } from "../../lib/cn";

// shadcn/ui Sheet: a Dialog that slides in from a screen edge.

export const Sheet = BaseDialog.Root;
export const SheetTrigger = BaseDialog.Trigger;
export const SheetClose = BaseDialog.Close;

const sideClass = {
  left: "inset-y-0 left-0 h-full w-72 border-r data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full",
  right: "inset-y-0 right-0 h-full w-80 border-l data-[ending-style]:translate-x-full data-[starting-style]:translate-x-full",
  top: "inset-x-0 top-0 border-b data-[ending-style]:-translate-y-full data-[starting-style]:-translate-y-full",
  bottom: "inset-x-0 bottom-0 border-t data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full"
} as const;

export function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof BaseDialog.Popup> & { side?: keyof typeof sideClass; showCloseButton?: boolean }): React.JSX.Element {
  return (
    <BaseDialog.Portal>
      {/* Below Dialog (900/901): a dialog opened from a sheet sits on top and dims it. */}
      <BaseDialog.Backdrop className="fixed inset-0 z-[880] bg-black/40 transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
      <BaseDialog.Popup
        data-slot="sheet-content"
        className={cn(
          "fixed z-[881] flex flex-col bg-background shadow-pop outline-none transition-transform duration-200 ease-[cubic-bezier(.32,.72,0,1)] motion-reduce:transition-none",
          sideClass[side],
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <BaseDialog.Close
            aria-label="Close"
            className="absolute right-3 top-3 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </BaseDialog.Close>
        ) : null}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}

export function SheetTitle({ className, ...props }: React.ComponentProps<typeof BaseDialog.Title>): React.JSX.Element {
  return <BaseDialog.Title data-slot="sheet-title" className={cn("text-lg font-semibold", className)} {...props} />;
}
