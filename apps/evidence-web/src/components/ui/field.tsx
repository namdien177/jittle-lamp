import React from "react";

import { cn } from "../../lib/cn";

export function Label({
  className,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>): React.JSX.Element {
  return (
    <label
      className={cn(
        " font-semibold uppercase tracking-[0.06em] text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A vertical form field: label, control (children) and an optional error/hint.
 * Pairs with react-hook-form — pass `error={errors.x?.message}`.
 */
export function Field(props: {
  label?: React.ReactNode;
  htmlFor?: string;
  error?: string | undefined;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={cn("flex flex-col gap-1.5", props.className)}>
      {props.label ? (
        <Label htmlFor={props.htmlFor}>{props.label}</Label>
      ) : null}
      {props.children}
      {props.error ? (
        <p className=" font-medium text-destructive">{props.error}</p>
      ) : props.hint ? (
        <p className=" text-muted-foreground">{props.hint}</p>
      ) : null}
    </div>
  );
}
