import React from "react";
import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronsUpDown } from "lucide-react";

import { cn } from "../../lib/cn";

export type SelectOption<TValue extends string> = {
  label: string;
  value: TValue;
};

export function Select<TValue extends string>(props: {
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  size?: "sm" | "md";
  options: Array<SelectOption<TValue>>;
  value: TValue;
  onValueChange: (value: TValue) => void;
}): React.JSX.Element {
  const { ariaLabel, className, disabled, size = "md", options, value, onValueChange } = props;

  return (
    <BaseSelect.Root
      items={options}
      value={value}
      {...(disabled !== undefined ? { disabled } : {})}
      onValueChange={(next) => {
        if (typeof next === "string") onValueChange(next as TValue);
      }}
    >
      <BaseSelect.Trigger
        aria-label={ariaLabel}
        className={cn(
          "inline-flex w-full items-center justify-between gap-2 rounded-md border border-input bg-black/20 px-3 text-sm text-foreground shadow-soft outline-none transition-colors",
          "hover:border-white/20 focus-visible:border-ring/70 focus-visible:ring-2 focus-visible:ring-ring/30",
          "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
          size === "sm" ? "h-8" : "h-9",
          className
        )}
      >
        <BaseSelect.Value className="min-w-0 truncate text-left" />
        <BaseSelect.Icon className="shrink-0 text-muted-foreground">
          <ChevronsUpDown aria-hidden className="size-3.5" strokeWidth={2} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner className="z-[950]" alignItemWithTrigger={false} sideOffset={6}>
          <BaseSelect.Popup
            className={cn(
              "jl-scroll max-h-[min(var(--available-height,18rem),18rem)] min-w-[var(--anchor-width)] overflow-auto rounded-lg border border-border-strong bg-popover p-1 text-popover-foreground shadow-pop",
              "transition-[opacity,transform] data-[starting-style]:opacity-0 data-[ending-style]:opacity-0"
            )}
          >
            <BaseSelect.List className="flex flex-col gap-0.5">
              {options.map((option) => (
                <BaseSelect.Item
                  key={option.value}
                  value={option.value}
                  className={cn(
                    "flex min-h-8 cursor-pointer items-center justify-between gap-2 rounded-md px-2 text-sm text-muted-foreground outline-none",
                    "data-[highlighted]:bg-white/[0.06] data-[highlighted]:text-foreground",
                    "data-[selected]:bg-primary/12 data-[selected]:text-foreground"
                  )}
                >
                  <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
                  <BaseSelect.ItemIndicator className="text-primary">
                    <Check aria-hidden className="size-3.5" strokeWidth={2.5} />
                  </BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
