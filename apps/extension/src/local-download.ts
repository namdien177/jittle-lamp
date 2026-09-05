export async function downloadRecordingArtifact(url: string, filename: string): Promise<void> {
  const downloadId = await chrome.downloads.download({ url, filename, saveAs: true, conflictAction: "uniquify" });
  if (typeof downloadId !== "number") throw new Error("The browser did not start the download.");
  await waitForDownload(downloadId);
}

async function waitForDownload(downloadId: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      globalThis.clearTimeout(timeoutId);
      chrome.downloads.onChanged.removeListener(listener);
    };
    const settle = (state: string | undefined): void => {
      if (settled || (state !== "complete" && state !== "interrupted")) {
        return;
      }

      settled = true;
      cleanup();
      if (state === "complete") {
        resolve();
      } else {
        reject(new Error("A local recorder download was interrupted."));
      }
    };
    const listener = (delta: chrome.downloads.DownloadDelta): void => {
      if (delta.id !== downloadId || !delta.state?.current) {
        return;
      }

      settle(delta.state.current);
    };
    const timeoutId = globalThis.setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(new Error("Timed out while waiting for a local recorder download."));
    }, 5 * 60 * 1_000);

    chrome.downloads.onChanged.addListener(listener);
    void chrome.downloads.search({ id: downloadId }).then(
      (items) => settle(items[0]?.state),
      () => undefined
    );
  });
}

