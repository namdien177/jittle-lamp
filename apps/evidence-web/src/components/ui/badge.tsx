import React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/cn";

export const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium leading-none whitespace-nowrap [&_svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-border-strong bg-secondary text-secondary-foreground",
        brand: "border-primary/35 bg-primary/12 text-brand-300",
        outline: "border-border-strong bg-transparent text-muted-foreground",
        success: "border-primary/35 bg-primary/12 text-brand-300",
        warning: "border-warning/35 bg-warning/12 text-warning",
        danger: "border-destructive/40 bg-destructive/12 text-destructive",
        muted: "border-transparent bg-white/[0.06] text-muted-foreground"
      }
    },
    defaultVariants: { variant: "default" }
  }
);

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
