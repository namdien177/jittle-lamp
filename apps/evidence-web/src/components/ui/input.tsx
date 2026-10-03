import React from "react";

import { cn } from "../../lib/cn";

export const inputClass =
  "flex h-8 w-full min-w-0 rounded-md border border-input bg-background px-2.5 py-1 text-sm text-foreground shadow-soft outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type, ...props },
  ref
) {
  return <input ref={ref} data-slot="input" type={type ?? "text"} className={cn(inputClass, className)} {...props} />;
});
