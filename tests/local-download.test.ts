import { afterEach, beforeEach, expect, test } from "bun:test";
import { downloadRecordingArtifact } from "../apps/extension/src/local-download";

let originalChrome: PropertyDescriptor | undefined;
let listeners: Set<(delta: chrome.downloads.DownloadDelta) => void>;
let currentState: string;
beforeEach(() => {
  originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  listeners = new Set();
  currentState = "in_progress";
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    downloads: {
      download: async () => 42,
      search: async () => [{ id: 42, state: currentState }],
      onChanged: { addListener: (fn: (delta: chrome.downloads.DownloadDelta) => void) => listeners.add(fn),
        removeListener: (fn: (delta: chrome.downloads.DownloadDelta) => void) => listeners.delete(fn) }
    }
  } });
});
afterEach(() => {
  if (originalChrome) Object.defineProperty(globalThis, "chrome", originalChrome);
  else Reflect.deleteProperty(globalThis, "chrome");
});

test("local save waits for completion and ignores another download", async () => {
  let finished = false;
  const save = downloadRecordingArtifact("blob:example", "recording.webm").then(() => { finished = true; });
  await Promise.resolve();
  for (const listener of listeners) listener({ id: 43, state: { current: "complete" } });
  await Promise.resolve();
  expect(finished).toBeFalse();
  for (const listener of listeners) listener({ id: 42, state: { current: "complete" } });
  await save;
  expect(finished).toBeTrue();
  expect(listeners.size).toBe(0);
});

test("a canceled save rejects and removes its listener", async () => {
  const save = downloadRecordingArtifact("blob:example", "recording.webm");
  await Promise.resolve();
  for (const listener of listeners) listener({ id: 42, state: { current: "interrupted" } });
  await expect(save).rejects.toThrow("interrupted");
  expect(listeners.size).toBe(0);
});

test("detects completion before the listener was registered", async () => {
  currentState = "complete";
  await downloadRecordingArtifact("blob:example", "recording.webm");
  expect(listeners.size).toBe(0);
});
