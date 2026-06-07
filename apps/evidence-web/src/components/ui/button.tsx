import React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/cn";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-base font-medium transition-[background,border,color,box-shadow,transform] outline-none focus-visible:ring-2 focus-visible:ring-ring/55 disabled:pointer-events-none disabled:opacity-50 active:translate-y-px [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 select-none",
  {
    variants: {
      variant: {
        primary:
          "bg-primary text-primary-foreground font-semibold shadow-soft hover:bg-brand-400 hover:shadow-[0_4px_18px_-6px_var(--brand-500)]",
        secondary:
          "border border-border-strong bg-secondary text-secondary-foreground hover:bg-white/[0.06] hover:border-white/20",
        outline:
          "border border-border-strong bg-transparent text-foreground hover:bg-white/[0.04] hover:border-white/20",
        ghost: "bg-transparent text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
        destructive:
          "border border-destructive/45 bg-transparent text-destructive hover:bg-destructive/12",
        link: "text-primary underline-offset-4 hover:underline px-0"
      },
      size: {
        xs: "h-8 px-3 text-sm",
        sm: "h-9 px-3.5",
        md: "h-10 px-4",
        lg: "h-11 px-6",
        icon: "size-10 p-0",
        "icon-sm": "size-9 p-0"
      }
    },
    defaultVariants: { variant: "primary", size: "md" }
  }
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, type, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
});
