import type { BrowserContext, Page } from "playwright-core";

// Interaction lock for `jl-e2e run --headed` (design.md §5.4, ADR 0002 decision 11). A transparent
// shield covers the page between runner actions so a person watching cannot click or type into the
// run by accident. Input on the shield while it is up pauses the run and shows a banner; Resume
// lifts the pause. The shield is lowered only while the runner performs an action.
//
// `Input.setIgnoreInputEvents` was tried first; it also drops Playwright's own CDP input, so the
// injected shield is used (handover §4 assumption 4).

export const lockScript = `(() => {
  if (window.__jlLock) return;
  const state = { up: true, paused: false, reason: null };
  const shield = document.createElement("div");
  shield.id = "__jl-shield";
  shield.setAttribute("aria-hidden", "true");
  shield.style.cssText = "position:fixed;inset:0;z-index:2147483646;background:transparent;cursor:not-allowed;";
  const banner = document.createElement("div");
  banner.id = "__jl-banner";
  banner.setAttribute("aria-hidden", "true");
  banner.style.cssText = "position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483647;font:13px system-ui;padding:8px 12px;border-radius:8px;background:#111;color:#fff;box-shadow:0 2px 12px rgba(0,0,0,.3);display:flex;gap:10px;align-items:center;transition:opacity .2s cubic-bezier(.23,1,.32,1)";
  const label = document.createElement("span");
  const resume = document.createElement("button");
  resume.textContent = "Resume";
  resume.style.cssText = "font:inherit;border:0;border-radius:6px;padding:4px 10px;background:#22c55e;color:#04210f;cursor:pointer;display:none";
  resume.addEventListener("click", (event) => { event.stopPropagation(); state.paused = false; state.reason = null; render(); }, true);
  banner.append(label, resume);
  const render = () => {
    label.textContent = state.paused ? "Paused: you interacted with the page. Nothing you do is recorded as a step." : "Jittle Lamp is running this test. Input is locked.";
    resume.style.display = state.paused ? "inline-block" : "none";
    shield.style.display = state.up && !state.paused ? "block" : "none";
  };
  const onUserInput = (event) => {
    if (!state.up || state.paused) return;
    if (event.target === resume) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    state.paused = true;
    state.reason = event.type;
    render();
  };
  for (const type of ["pointerdown", "mousedown", "click", "keydown", "wheel", "touchstart"]) {
    window.addEventListener(type, onUserInput, { capture: true, passive: false });
  }
  const mount = () => { if (!document.documentElement) return; document.documentElement.append(shield, banner); render(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true }); else mount();
  window.__jlLock = {
    down() { state.up = false; render(); },
    up() { state.up = true; render(); },
    status() { return { up: state.up, paused: state.paused, reason: state.reason }; }
  };
})();`;

export async function installInteractionLock(context: BrowserContext): Promise<void> {
  await context.addInitScript({ content: lockScript });
}

async function call(page: Page, method: "down" | "up"): Promise<void> {
  await page.evaluate((name) => {
    const lock = (window as unknown as { __jlLock?: Record<string, () => void> }).__jlLock;
    lock?.[name]?.();
  }, method).catch(() => undefined);
}

export async function lockStatus(page: Page): Promise<{ up: boolean; paused: boolean; reason: string | null } | null> {
  return page
    .evaluate(() => (window as unknown as { __jlLock?: { status(): { up: boolean; paused: boolean; reason: string | null } } }).__jlLock?.status() ?? null)
    .catch(() => null);
}

// Run one runner action with the shield lowered. A paused run waits here until the person resumes.
export async function withLockLowered<T>(page: Page, action: () => Promise<T>, pollMs = 250): Promise<T> {
  for (;;) {
    const status = await lockStatus(page);
    if (!status?.paused) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  await call(page, "down");
  try {
    return await action();
  } finally {
    await call(page, "up");
  }
}
