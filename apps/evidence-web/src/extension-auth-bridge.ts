type ClerkTokenProvider = {
  loaded?: boolean;
  session?: {
    getToken: (options?: { skipCache?: boolean }) => Promise<string | null>;
  } | null;
};

declare global {
  interface Window {
    Clerk?: ClerkTokenProvider;
  }
}

let bridgeStarted = false;

export function startExtensionAuthBridge(): void {
  if (bridgeStarted) {
    return;
  }

  bridgeStarted = true;
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) {
      return;
    }

    const data = event.data as {
      source?: unknown;
      type?: unknown;
      nonce?: unknown;
    };

    if (
      data?.source !== "jittle-lamp-extension" ||
      data.type !== "jittle-lamp-extension-auth-token-request" ||
      typeof data.nonce !== "string"
    ) {
      return;
    }

    void resolveCurrentToken().then((token) => {
      window.postMessage(
        {
          source: "jittle-lamp-web-auth-bridge",
          type: "jittle-lamp-extension-auth-token-response",
          nonce: data.nonce,
          token
        },
        window.location.origin
      );
    });
  });
}

async function resolveCurrentToken(): Promise<string | null> {
  const clerk = await waitForLoadedClerk();

  if (!clerk?.session) {
    return null;
  }

  return clerk.session.getToken({ skipCache: true }).catch(() => null);
}

async function waitForLoadedClerk(): Promise<ClerkTokenProvider | null> {
  const deadline = Date.now() + 700;

  while (Date.now() <= deadline) {
    if (window.Clerk?.loaded) {
      return window.Clerk;
    }

    await delay(50);
  }

  return window.Clerk?.loaded ? window.Clerk : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
