import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { chromium, type Browser, type Page } from "playwright";

import { lockScript, lockStatus, withLockLowered } from "../src/runtime/interaction-lock";

// Handover §4 assumption 4: `Input.setIgnoreInputEvents` blocks Playwright's own CDP input as well
// as the user's, so it cannot lock a headed run; the injected shield is used instead.

const html = `<!doctype html><html><body><button id="b" onclick="window.clicks=(window.clicks||0)+1">Count</button><input id="t" aria-label="Name"></body></html>`;
let browser: Browser;

async function freshPage(withShield: boolean): Promise<Page> {
  const context = await browser.newContext();
  if (withShield) await context.addInitScript({ content: lockScript });
  const page = await context.newPage();
  // A real navigation, as in a run; setContent's document.open() would clear window listeners.
  await page.route("http://lock.test/", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://lock.test/");
  return page;
}

beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

describe("interaction lock (design.md §5.4)", () => {
  test("Input.setIgnoreInputEvents also drops Playwright input", async () => {
    const page = await freshPage(false);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.setIgnoreInputEvents", { ignore: true });
    await page.click("#b", { timeout: 2000 }).catch(() => undefined);
    await page.keyboard.type("abc").catch(() => undefined);
    expect(await page.evaluate(() => (window as unknown as { clicks?: number }).clicks ?? 0)).toBe(0);
    expect(await page.inputValue("#t")).toBe("");
    await cdp.send("Input.setIgnoreInputEvents", { ignore: false });
    await page.click("#b");
    expect(await page.evaluate(() => (window as unknown as { clicks?: number }).clicks ?? 0)).toBe(1);
  });

  test("the injected shield lets runner actions through and pauses on user input", async () => {
    const page = await freshPage(true);
    // Runner action: the shield is lowered for its duration.
    await withLockLowered(page, () => page.click("#b"));
    expect(await page.evaluate(() => (window as unknown as { clicks?: number }).clicks ?? 0)).toBe(1);
    expect((await lockStatus(page))?.up).toBe(true);

    // A person clicking while the shield is up hits the shield, not the page, and pauses the run.
    const box = await page.locator("#b").boundingBox();
    if (!box) throw new Error("no button box");
    await page.mouse.click(box.x + 5, box.y + 5);
    expect(await page.evaluate(() => (window as unknown as { clicks?: number }).clicks ?? 0)).toBe(1);
    expect((await lockStatus(page))?.paused).toBe(true);
    expect(await page.locator("#__jl-banner").innerText()).toContain("Paused");

    // The next runner action waits until the person resumes.
    let ran = false;
    const pending = withLockLowered(page, async () => {
      ran = true;
    }, 50);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ran).toBe(false);
    await page.evaluate(() => (document.querySelector("#__jl-banner button") as HTMLButtonElement).click());
    await pending;
    expect(ran).toBe(true);
    expect((await lockStatus(page))?.paused).toBe(false);
  });

  test("the shield is hidden from the accessibility tree the model reads", async () => {
    const page = await freshPage(true);
    const tree = await page.locator("body").ariaSnapshot();
    expect(tree).not.toContain("Jittle Lamp");
    expect(tree).toContain('button "Count"');
  });
});
