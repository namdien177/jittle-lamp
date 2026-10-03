import React from "react";
import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronsUpDown } from "lucide-react";

import { cn } from "../../lib/cn";

// shadcn/ui Select on Base UI primitives.

export const Select = BaseSelect.Root;
export const SelectGroup = BaseSelect.Group;

export function SelectValue({ className, ...props }: React.ComponentProps<typeof BaseSelect.Value>): React.JSX.Element {
  return <BaseSelect.Value data-slot="select-value" className={cn("min-w-0 truncate text-left", className)} {...props} />;
}

export function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof BaseSelect.Trigger> & { size?: "sm" | "default" }): React.JSX.Element {
  return (
    <BaseSelect.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "inline-flex w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-sm text-foreground shadow-soft outline-none transition-[border-color,box-shadow] dark:bg-input/30",
        "hover:border-border-strong focus-visible:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring/25 data-[popup-open]:border-ring/60",
        "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        size === "sm" ? "h-7" : "h-8",
        className
      )}
      {...props}
    >
      {children}
      <BaseSelect.Icon className="shrink-0 text-muted-foreground">
        <ChevronsUpDown aria-hidden className="size-3.5" />
      </BaseSelect.Icon>
    </BaseSelect.Trigger>
  );
}

export function SelectContent({ className, children, ...props }: React.ComponentProps<typeof BaseSelect.Popup>): React.JSX.Element {
  return (
    <BaseSelect.Portal>
      <BaseSelect.Positioner className="z-[950] outline-none" alignItemWithTrigger={false} sideOffset={4}>
        <BaseSelect.Popup
          data-slot="select-content"
          className={cn(
            "jl-scroll max-h-[min(var(--available-height,18rem),18rem)] min-w-[var(--anchor-width)] origin-[var(--transform-origin)] overflow-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-pop",
            "transition-[opacity,transform] duration-150 ease-[cubic-bezier(.23,1,.32,1)] data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0",
            className
          )}
          {...props}
        >
          <BaseSelect.List className="flex flex-col">{children}</BaseSelect.List>
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  );
}

export function SelectItem({ className, children, ...props }: React.ComponentProps<typeof BaseSelect.Item>): React.JSX.Element {
  return (
    <BaseSelect.Item
      data-slot="select-item"
      className={cn(
        "relative flex h-7 cursor-default select-none items-center gap-2 rounded-md pl-2 pr-7 text-sm text-foreground outline-none",
        "data-[highlighted]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
      {...props}
    >
      <BaseSelect.ItemText className="min-w-0 truncate">{children}</BaseSelect.ItemText>
      <BaseSelect.ItemIndicator className="absolute right-2 text-foreground">
        <Check aria-hidden className="size-3.5" />
      </BaseSelect.ItemIndicator>
    </BaseSelect.Item>
  );
}

export function SelectLabel({ className, ...props }: React.ComponentProps<typeof BaseSelect.GroupLabel>): React.JSX.Element {
  return <BaseSelect.GroupLabel data-slot="select-label" className={cn("px-2 py-1 text-xs text-muted-foreground", className)} {...props} />;
}

export function SelectSeparator({ className, ...props }: React.ComponentProps<typeof BaseSelect.Separator>): React.JSX.Element {
  return <BaseSelect.Separator data-slot="select-separator" className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

export type SelectOption<TValue extends string> = {
  label: string;
  value: TValue;
};

/** Options-driven select composed from the parts above. */
export function SimpleSelect<TValue extends string>(props: {
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
    <Select
      items={options}
      value={value}
      {...(disabled !== undefined ? { disabled } : {})}
      onValueChange={(next) => {
        if (typeof next === "string") onValueChange(next as TValue);
      }}
    >
      <SelectTrigger aria-label={ariaLabel} size={size === "sm" ? "sm" : "default"} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
