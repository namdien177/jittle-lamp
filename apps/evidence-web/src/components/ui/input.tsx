import React from "react";

import { cn } from "../../lib/cn";

export const inputClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-1.5 text-base text-foreground shadow-soft transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring/70 focus-visible:bg-card focus-visible:ring-2 focus-visible:ring-ring/30 outline-none disabled:cursor-not-allowed disabled:opacity-50";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type, ...props },
  ref
) {
  return (
    <input ref={ref} type={type ?? "text"} className={cn(inputClass, className)} {...props} />
  );
});

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, ...props },
  ref
) {
  return (
    <textarea
      ref={ref}
      className={cn(inputClass, "h-auto min-h-[80px] py-2 leading-relaxed", className)}
      {...props}
    />
  );
});
