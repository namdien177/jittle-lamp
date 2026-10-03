import React from "react";
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { Check, Minus } from "lucide-react";

import { cn } from "../../lib/cn";

export function Checkbox({ className, ...props }: React.ComponentProps<typeof BaseCheckbox.Root>): React.JSX.Element {
  return (
    <BaseCheckbox.Root
      data-slot="checkbox"
      className={cn(
        "peer inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input bg-background shadow-soft outline-none transition-colors dark:bg-input/30",
        "focus-visible:ring-2 focus-visible:ring-ring/40 data-[checked]:border-primary data-[checked]:bg-primary data-[checked]:text-primary-foreground data-[indeterminate]:border-primary data-[indeterminate]:bg-primary data-[indeterminate]:text-primary-foreground data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        className
      )}
      {...props}
    >
      <BaseCheckbox.Indicator
        data-slot="checkbox-indicator"
        keepMounted
        className="flex items-center justify-center data-[unchecked]:hidden"
        render={(indicatorProps, state) => (
          <span {...indicatorProps}>
            {state.indeterminate ? <Minus className="size-3" strokeWidth={3} aria-hidden /> : <Check className="size-3" strokeWidth={3} aria-hidden />}
          </span>
        )}
      />
    </BaseCheckbox.Root>
  );
}
