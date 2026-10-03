import React from "react";
import { Loader2 } from "lucide-react";

import { cn } from "../../lib/cn";

export function Spinner({ className, ...props }: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return <Loader2 data-slot="spinner" role="status" aria-label="Loading" className={cn("size-4 animate-spin", className)} {...props} />;
}
