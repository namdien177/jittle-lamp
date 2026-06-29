type ProbeMessage = {
  source: "jittle-lamp-network-probe";
  payload: {
    method: string;
    url: string;
    status?: number;
    requestBody?: {
      disposition: "captured" | "truncated" | "omitted" | "unavailable";
      value?: string;
      reason?: string;
    };
    failureText?: string;
  };
};

type ReceivedRequest = {
  method: string;
  url: string;
  body: string;
};

const probeMessages: ProbeMessage[] = [];

class TestXMLHttpRequest {
  response = null;
  responseText = "";
  responseType: XMLHttpRequestResponseType = "";
  responseURL = "";
  status = 0;
  statusText = "";

  open(): void {}
  send(): void {}
  setRequestHeader(): void {}
  addEventListener(): void {}
  getAllResponseHeaders(): string {
    return "";
  }
}

const testWindow = globalThis as typeof globalThis & {
  __jittleLampNetworkProbeInstalled__?: boolean;
  postMessage: typeof postMessage;
  XMLHttpRequest: typeof XMLHttpRequest;
  window: Window;
};

(testWindow as unknown as { window: unknown }).window = testWindow;
testWindow.postMessage = (message: unknown) => {
  if (isProbeMessage(message)) {
    probeMessages.push(message);
  }
};
testWindow.XMLHttpRequest = TestXMLHttpRequest as unknown as typeof XMLHttpRequest;
delete testWindow.__jittleLampNetworkProbeInstalled__;

const networkProbePath = "../../apps/extension/src/network-probe";
await import(networkProbePath);

await assertPostRequestBodyReachesServer();
await assertPostInitBodyReachesServerAndCapturesBody();

console.info("network probe e2e passed");

async function assertPostRequestBodyReachesServer(): Promise<void> {
  const received: ReceivedRequest[] = [];
  const server = startEchoServer(received);

  try {
    const response = await fetch(
      new Request(new URL("/request-body", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello from request" })
      })
    );

    assertEqual(response.status, 200, "Request body POST should return 200.");
    assertEqual(JSON.stringify(received), JSON.stringify([
      {
        method: "POST",
        url: "/request-body",
        body: '{"message":"hello from request"}'
      }
    ]), "Server should receive the Request body POST.");

    const payload = lastProbePayloadFor("/request-body");
    assertEqual(payload?.status, 200, "Probe should record Request body POST status.");
    assertEqual(payload?.requestBody?.disposition, "unavailable", "Existing Request body should not be read.");
    assertIncludes(payload?.requestBody?.reason, "skipped", "Existing Request body reason should mention skip.");
    assertEqual(payload?.failureText, undefined, "Probe should not record fetch failure.");
  } finally {
    server.stop(true);
  }
}

async function assertPostInitBodyReachesServerAndCapturesBody(): Promise<void> {
  const received: ReceivedRequest[] = [];
  const server = startEchoServer(received);

  try {
    const response = await fetch(new URL("/init-body", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello from init" })
    });

    assertEqual(response.status, 200, "Init body POST should return 200.");
    assertEqual(JSON.stringify(received), JSON.stringify([
      {
        method: "POST",
        url: "/init-body",
        body: '{"message":"hello from init"}'
      }
    ]), "Server should receive the init body POST.");

    const payload = lastProbePayloadFor("/init-body");
    assertEqual(payload?.status, 200, "Probe should record init body POST status.");
    assertEqual(payload?.requestBody?.disposition, "captured", "Safe init body should be captured.");
    assertEqual(payload?.requestBody?.value, '{"message":"hello from init"}', "Safe init body should match.");
    assertEqual(payload?.failureText, undefined, "Probe should not record fetch failure.");
  } finally {
    server.stop(true);
  }
}

function startEchoServer(received: ReceivedRequest[]): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      received.push({
        method: request.method,
        url: url.pathname,
        body: await request.text()
      });

      return Response.json({ ok: true });
    }
  });
}

function lastProbePayloadFor(pathname: string): ProbeMessage["payload"] | undefined {
  return probeMessages
    .map((message) => message.payload)
    .filter((payload) => new URL(payload.url).pathname === pathname)
    .at(-1);
}

function isProbeMessage(message: unknown): message is ProbeMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "source" in message &&
    (message as ProbeMessage).source === "jittle-lamp-network-probe" &&
    "payload" in message
  );
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}\nExpected: ${String(expected)}\nActual: ${String(actual)}`);
  }
}

function assertIncludes(actual: string | undefined, expected: string, message: string): void {
  if (!actual?.includes(expected)) {
    throw new Error(`${message}\nExpected to include: ${expected}\nActual: ${String(actual)}`);
  }
}

export {};
