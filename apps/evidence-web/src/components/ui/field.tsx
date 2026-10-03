import React from "react";

import { cn } from "../../lib/cn";
import { Label } from "./label";

export function FieldLabel(props: React.LabelHTMLAttributes<HTMLLabelElement>): React.JSX.Element {
  return <Label data-slot="field-label" {...props} />;
}

export function FieldDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>): React.JSX.Element {
  return <p data-slot="field-description" className={cn("text-xs leading-normal text-muted-foreground", className)} {...props} />;
}

export function FieldError({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>): React.JSX.Element {
  return <p data-slot="field-error" role="alert" className={cn("text-xs font-medium text-destructive", className)} {...props} />;
}

export function FieldGroup({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div data-slot="field-group" className={cn("flex flex-col gap-4", className)} {...props} />;
}

/**
 * A vertical form field (shadcn `Field`). Compose it with FieldLabel / FieldDescription /
 * FieldError, or pass `label`, `hint` and `error` for the common case. Pairs with
 * react-hook-form — pass `error={errors.x?.message}`.
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
    <div data-slot="field" data-invalid={props.error ? "true" : undefined} className={cn("flex flex-col gap-1.5", props.className)}>
      {props.label ? <FieldLabel htmlFor={props.htmlFor}>{props.label}</FieldLabel> : null}
      {props.children}
      {props.error ? <FieldError>{props.error}</FieldError> : props.hint ? <FieldDescription>{props.hint}</FieldDescription> : null}
    </div>
  );
}
