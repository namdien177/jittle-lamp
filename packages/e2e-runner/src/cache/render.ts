import type { ActionTrace, RecordedAction, TraceTargetDescriptor } from "e2e";

// Readable Playwright for a cached action record (design.md §5.2). The record stays the replay
// source; this is the view people read, copy and export.

const q = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export function renderLocator(target: TraceTargetDescriptor, root = "page"): string {
  const scope = target.within ? `${root}.locator(${q(target.within)})` : root;
  if (target.testId) return `${scope}.getByTestId(${q(target.testId)})`;
  if (target.role) return target.name ? `${scope}.getByRole(${q(target.role)}, { name: ${q(target.name)} })` : `${scope}.getByRole(${q(target.role)})`;
  if (target.placeholder) return `${scope}.getByPlaceholder(${q(target.placeholder)})`;
  if (target.text) return `${scope}.getByText(${q(target.text)})`;
  if (target.selector) return `${scope}.locator(${q(target.selector)})`;
  if (target.name) return `${scope}.getByLabel(${q(target.name)})`;
  return `${scope}.locator('body')`;
}

function renderAction(action: RecordedAction): string {
  switch (action.name) {
    case "tap":
      return `await ${renderLocator(action.target)}.click();`;
    case "doubleTap":
      return `await ${renderLocator(action.target)}.dblclick();`;
    case "longPress":
      return `await ${renderLocator(action.target)}.click({ delay: 800 });`;
    case "secondaryTap":
      return `await ${renderLocator(action.target)}.click({ button: 'right' });`;
    case "hover":
      return `await ${renderLocator(action.target)}.hover();`;
    case "scrollTo":
      return `await ${renderLocator(action.target)}.scrollIntoViewIfNeeded();`;
    case "type":
      return `await ${renderLocator(action.target)}.fill(${q(action.value)});`;
    case "typeSecret":
      return `await ${renderLocator(action.target)}.fill(secret(${q(action.secret)}));`;
    case "press":
      return `await ${renderLocator(action.target)}.press(${q(action.key)});`;
    case "select":
      return `await ${renderLocator(action.target)}.selectOption(${q(action.value)});`;
    case "check":
      return `await ${renderLocator(action.target)}.setChecked(${action.checked});`;
    case "upload":
      return `await ${renderLocator(action.target)}.setInputFiles([${action.paths.map(q).join(", ")}]);`;
    case "drag":
      return `await ${renderLocator(action.target)}.dragTo(${renderLocator(action.destination)});`;
    case "scroll":
      return `await page.mouse.wheel(0, ${action.direction === "up" ? -600 : 600} * ${action.times ?? 1});`;
    case "scrollUntil":
      return `await page.getByText(${q(action.text)}).scrollIntoViewIfNeeded();`;
    case "navigate":
      return `await page.goto(${q(action.url)});`;
    case "back":
      return "await page.goBack();";
    case "tapAt":
      return `await page.mouse.click(${action.point.x}, ${action.point.y});`;
    case "hoverAt":
      return `await page.mouse.move(${action.point.x}, ${action.point.y});`;
    case "typeText":
      return `await page.keyboard.type(${q(action.value)});`;
    case "pressKey":
      return `await page.keyboard.press(${q(action.key)});`;
    case "dismissKeyboard":
      return "await page.keyboard.press('Escape');";
    case "tool":
      return `// ${action.summary}`;
  }
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export function renderPlaywright(trace: ActionTrace): string {
  const lines = trace.actions.map(renderAction);
  if (trace.endPath) lines.push(`await expect(page).toHaveURL(/${escapeRegExp(trace.endPath)}/);`);
  for (const anchor of trace.endAnchors ?? []) lines.push(`await expect(${renderLocator(anchor)}).toBeVisible();`);
  return lines.join("\n");
}
