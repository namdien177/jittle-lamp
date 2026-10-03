import React from "react";

import { cn } from "../../lib/cn";
import { inputClass } from "./input";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, ...props },
  ref
) {
  return (
    <textarea
      ref={ref}
      data-slot="textarea"
      className={cn(inputClass, "h-auto min-h-16 py-1.5 leading-relaxed", className)}
      {...props}
    />
  );
});
