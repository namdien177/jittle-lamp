import React from "react";

import { cn } from "../lib/cn";

/**
 * The app's desk-lamp logo, recoloured to the brand green. The source artwork is
 * a dark glyph on white, so `invert` + `mix-blend-screen` drops the white field
 * on dark surfaces and the hue rotation tints the remaining mark.
 */
export function BrandMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        "relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-md border border-primary/30 bg-[radial-gradient(circle_at_30%_20%,var(--brand-800),#0b0d0e)]",
        className
      )}
    >
      <span className="absolute inset-0 grid-backdrop opacity-40" />
      <img
        src="/logo.jpg"
        alt=""
        className="relative size-7 object-contain mix-blend-screen [filter:invert(1)_brightness(1.6)_sepia(1)_saturate(6)_hue-rotate(74deg)]"
      />
    </span>
  );
}

export function Wordmark({
  className,
  showMark = true
}: {
  className?: string;
  showMark?: boolean;
}): React.JSX.Element {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      {showMark ? <BrandMark /> : null}
      <span className="font-display text-base font-bold leading-none tracking-tight text-foreground">
        Jittle&nbsp;Lamp
      </span>
    </span>
  );
}
