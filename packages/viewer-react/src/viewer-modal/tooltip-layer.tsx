import { useEffect, useRef } from "react";
import type * as React from "react";

// One tooltip for every `[data-tip]` element inside the viewer. The viewer root is a size
// container, which makes it the containing block for positioned descendants, so the tooltip is
// placed relative to the root and kept inside it. A label that is already visible (a header
// button wide enough to show its text) gets no tooltip.

type Side = "top" | "bottom" | "left" | "right";

const OPEN_DELAY_MS = 350;
// Moving from one tooltip target to another within this window opens the next one at once.
const WARM_WINDOW_MS = 300;
const GAP = 6;
const EDGE = 4;

function labelIsVisible(target: HTMLElement): boolean {
  const label = target.querySelector<HTMLElement>(".jl-vm-btn-label");
  return Boolean(label && label.getBoundingClientRect().width > 1);
}

function place(target: HTMLElement, root: HTMLElement, tip: HTMLElement, preferred: Side): { left: number; top: number; side: Side } {
  const t = target.getBoundingClientRect();
  const r = root.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const fits = {
    top: t.top - GAP - h >= r.top + EDGE,
    bottom: t.bottom + GAP + h <= r.bottom - EDGE,
    left: t.left - GAP - w >= r.left + EDGE,
    right: t.right + GAP + w <= r.right - EDGE
  };
  const opposite: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };
  const side = fits[preferred] || !fits[opposite[preferred]] ? preferred : opposite[preferred];
  let left: number;
  let top: number;
  if (side === "top" || side === "bottom") {
    left = t.left + t.width / 2 - w / 2;
    top = side === "top" ? t.top - GAP - h : t.bottom + GAP;
  } else {
    top = t.top + t.height / 2 - h / 2;
    left = side === "left" ? t.left - GAP - w : t.right + GAP;
  }
  left = Math.min(Math.max(left, r.left + EDGE), r.right - EDGE - w);
  top = Math.min(Math.max(top, r.top + EDGE), r.bottom - EDGE - h);
  return { left: left - r.left, top: top - r.top, side };
}

// The tooltip element has no React children: the effect below owns its text and position.
export function ViewerTooltipLayer(): React.JSX.Element {
  const tipRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const tipEl = tipRef.current;
    const root = tipEl?.closest<HTMLElement>(".jl-vm-root, .jl-vm-modal");
    if (!tipEl || !root) return;

    let current: HTMLElement | null = null;
    let timer: number | undefined;
    let lastHiddenAt = 0;

    const hide = (): void => {
      window.clearTimeout(timer);
      if (current) lastHiddenAt = Date.now();
      current = null;
      tipEl.dataset.visible = "false";
    };

    const show = (target: HTMLElement): void => {
      const text = target.dataset.tip;
      if (!text || labelIsVisible(target)) return;
      const side = (target.dataset.tipSide as Side | undefined) ?? "bottom";
      tipEl.textContent = text;
      const position = place(target, root, tipEl, side);
      tipEl.style.left = `${position.left}px`;
      tipEl.style.top = `${position.top}px`;
      tipEl.dataset.side = position.side;
      tipEl.dataset.visible = "true";
    };

    const schedule = (target: HTMLElement): void => {
      window.clearTimeout(timer);
      current = target;
      const warm = Date.now() - lastHiddenAt < WARM_WINDOW_MS;
      timer = window.setTimeout(() => {
        if (current === target && target.isConnected) show(target);
      }, warm ? 0 : OPEN_DELAY_MS);
    };

    const onPointerOver = (event: PointerEvent): void => {
      if (event.pointerType === "touch") return;
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-tip]");
      if (!target || !root.contains(target)) return;
      if (target !== current) schedule(target);
    };
    const onPointerOut = (event: PointerEvent): void => {
      if (!current) return;
      const next = event.relatedTarget as Node | null;
      if (next && current.contains(next)) return;
      hide();
    };
    const onFocusIn = (event: FocusEvent): void => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-tip]");
      if (!target || !target.matches(":focus-visible")) return;
      window.clearTimeout(timer);
      current = target;
      show(target);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") hide();
    };

    root.addEventListener("pointerover", onPointerOver);
    root.addEventListener("pointerout", onPointerOut);
    root.addEventListener("pointerdown", hide);
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", hide);
    root.addEventListener("scroll", hide, true);
    root.addEventListener("wheel", hide, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      root.removeEventListener("pointerover", onPointerOver);
      root.removeEventListener("pointerout", onPointerOut);
      root.removeEventListener("pointerdown", hide);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", hide);
      root.removeEventListener("scroll", hide, true);
      root.removeEventListener("wheel", hide);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return <div ref={tipRef} className="jl-vm-tip" role="tooltip" aria-hidden="true" data-visible="false" />;
}
