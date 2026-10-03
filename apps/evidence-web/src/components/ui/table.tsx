import React from "react";

import { cn } from "../../lib/cn";

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>): React.JSX.Element {
  return (
    <div data-slot="table-container" className="jl-scroll relative w-full overflow-x-auto">
      <table data-slot="table" className={cn("w-full caption-bottom border-collapse text-sm", className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>): React.JSX.Element {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b [&_tr]:border-border [&_tr]:hover:bg-transparent", className)} {...props} />;
}

export function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>): React.JSX.Element {
  return <tbody data-slot="table-body" className={cn("[&_tr:last-child]:border-0 [&_tr]:border-b [&_tr]:border-border", className)} {...props} />;
}

export function TableRow({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>): React.JSX.Element {
  return (
    <tr
      data-slot="table-row"
      className={cn("transition-colors hover:bg-muted/60 data-[active=true]:bg-accent data-[state=selected]:bg-accent", className)}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>): React.JSX.Element {
  return (
    <th
      data-slot="table-head"
      className={cn("h-8 whitespace-nowrap px-3 text-left align-middle text-xs font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>): React.JSX.Element {
  return <td data-slot="table-cell" className={cn("px-3 py-2 align-middle", className)} {...props} />;
}
