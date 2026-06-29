type NetworkProbeBody = {
  disposition: "captured" | "truncated" | "omitted" | "unavailable";
  encoding?: "utf8";
  mimeType?: string;
  value?: string;
  byteLength?: number;
  omittedByteLength?: number;
  reason?: string;
};

type NetworkProbePayload = {
  requestId: string;
  method: string;
  url: string;
  subtype: "xhr" | "fetch";
  status?: number;
  statusText?: string;
  durationMs?: number;
  requestHeaders: Array<{ name: string; value: string }>;
  responseHeaders: Array<{ name: string; value: string }>;
  requestBody?: NetworkProbeBody;
  responseBody?: NetworkProbeBody;
  failureText?: string;
};

type FetchProbeRequestMetadata = {
  method: string;
  url: string;
  headers: Headers;
};

const globalWindow = window as typeof window & {
  __jittleLampNetworkProbeInstalled__?: boolean;
};
const captureLimit = 64 * 1024;

if (!globalWindow.__jittleLampNetworkProbeInstalled__) {
  globalWindow.__jittleLampNetworkProbeInstalled__ = true;
  installFetchProbe();
  installXhrProbe();
}

function installFetchProbe(): void {
  const originalFetch = globalWindow.fetch;

  const patchedFetch = async function patchedFetch(
    this: typeof globalWindow,
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const startedAtMs = performance.now();
    const requestId = `page-fetch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const request = getFetchRequestMetadata(input, init);
    const requestBodyPromise = captureFetchRequestBody(input, init, request.method);

    try {
      const response = (await Reflect.apply(originalFetch, this, arguments as unknown as unknown[])) as Response;
      const responseBody = await captureResponseBody(response.clone());
      const requestBody = await requestBodyPromise;

      postNetworkPayload({
        requestId,
        method: request.method,
        url: response.url || request.url,
        subtype: "fetch",
        status: response.status,
        statusText: response.statusText,
        durationMs: performance.now() - startedAtMs,
        requestHeaders: headersToEntries(request.headers),
        responseHeaders: headersToEntries(response.headers),
        ...(requestBody ? { requestBody } : {}),
        ...(responseBody ? { responseBody } : {})
      });

      return response;
    } catch (error: unknown) {
      const requestBody = await requestBodyPromise;

      postNetworkPayload({
        requestId,
        method: request.method,
        url: request.url,
        subtype: "fetch",
        durationMs: performance.now() - startedAtMs,
        requestHeaders: headersToEntries(request.headers),
        responseHeaders: [],
        ...(requestBody ? { requestBody } : {}),
        failureText: error instanceof Error ? error.message : String(error)
      });

      throw error;
    }
  };

  globalWindow.fetch = patchedFetch as typeof fetch;
}

function getFetchRequestMetadata(input: RequestInfo | URL, init?: RequestInit): FetchProbeRequestMetadata {
  const inputRequest = input instanceof Request ? input : undefined;
  const headers = new Headers(inputRequest?.headers);

  if (init?.headers) {
    new Headers(init.headers).forEach((value, name) => {
      headers.set(name, value);
    });
  }

  return {
    method: (init?.method ?? inputRequest?.method ?? "GET").toUpperCase(),
    url: inputRequest?.url ?? String(input),
    headers
  };
}

function installXhrProbe(): void {
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const xhrStates = new WeakMap<XMLHttpRequest, {
    requestId: string;
    method: string;
    url: string;
    startedAtMs: number;
    requestHeaders: Array<{ name: string; value: string }>;
    requestBody?: NetworkProbeBody;
  }>();

  XMLHttpRequest.prototype.open = function patchedOpen(method: string, url: string | URL): void {
    xhrStates.set(this, {
      requestId: `page-xhr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      method,
      url: String(url),
      startedAtMs: 0,
      requestHeaders: []
    });
    return Reflect.apply(originalOpen, this, arguments as unknown as unknown[]) as void;
  };

  XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(name: string, value: string): void {
    const state = xhrStates.get(this);

    if (state) {
      state.requestHeaders.push({ name, value });
    }

    return originalSetRequestHeader.apply(this, [name, value]);
  };

  XMLHttpRequest.prototype.send = function patchedSend(body?: Document | XMLHttpRequestBodyInit | null): void {
    const state = xhrStates.get(this);

    if (state) {
      state.startedAtMs = performance.now();
      void bodyToCapture(body).then((requestBody) => {
        if (requestBody) {
          state.requestBody = requestBody;
        }
      });

      this.addEventListener(
        "loadend",
        () => {
          void Promise.resolve().then(async () => {
            const responseHeaders = parseRawHeaders(this.getAllResponseHeaders());
            const contentType = headerValue(responseHeaders, "content-type");
            const responseBody = await captureXhrResponseBody(this, contentType);

            postNetworkPayload({
              requestId: state.requestId,
              method: state.method,
              url: this.responseURL || state.url,
              subtype: "xhr",
              durationMs: performance.now() - state.startedAtMs,
              requestHeaders: state.requestHeaders,
              responseHeaders,
              ...(this.status ? { status: this.status } : {}),
              ...(this.statusText ? { statusText: this.statusText } : {}),
              ...(state.requestBody ? { requestBody: state.requestBody } : {}),
              ...(responseBody ? { responseBody } : {}),
              ...(this.status === 0 ? { failureText: "XMLHttpRequest completed without an HTTP status." } : {})
            });
          });
        },
        { once: true }
      );
    }

    return Reflect.apply(originalSend, this, arguments as unknown as unknown[]) as void;
  };
}

function postNetworkPayload(payload: NetworkProbePayload): void {
  globalWindow.postMessage(
    {
      source: "jittle-lamp-network-probe",
      payload
    },
    "*"
  );
}

function captureFetchRequestBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  method: string
): Promise<NetworkProbeBody | undefined> {
  if (method === "GET" || method === "HEAD") {
    return Promise.resolve(undefined);
  }

  if (init && "body" in init && init.body !== undefined) {
    return safelyCaptureBody(init.body);
  }

  if (!(input instanceof Request)) {
    return Promise.resolve(undefined);
  }

  if (input.bodyUsed) {
    return Promise.resolve({
      disposition: "unavailable",
      reason: "Request body is already used."
    });
  }

  if (input.body) {
    return Promise.resolve({
      disposition: "unavailable",
      reason: "Request body capture skipped to avoid disturbing the original request."
    });
  }

  return Promise.resolve(undefined);
}

function safelyCaptureBody(body: BodyInit | Document | null | undefined): Promise<NetworkProbeBody | undefined> {
  try {
    return bodyToCapture(body).catch((error: unknown) => ({
      disposition: "unavailable",
      reason: error instanceof Error ? error.message : String(error)
    }));
  } catch (error: unknown) {
    return Promise.resolve({
      disposition: "unavailable",
      reason: error instanceof Error ? error.message : String(error)
    });
  }
}

async function captureResponseBody(response: Response): Promise<NetworkProbeBody | undefined> {
  const contentType = response.headers.get("content-type") || undefined;

  if (!isTextLikeContentType(contentType)) {
    return {
      disposition: "omitted",
      ...(contentType ? { mimeType: contentType } : {}),
      reason: "Response content type is not text-like."
    };
  }

  try {
    return textToCapture(await response.text(), contentType);
  } catch (error: unknown) {
    return {
      disposition: "unavailable",
      ...(contentType ? { mimeType: contentType } : {}),
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

async function captureXhrResponseBody(
  xhr: XMLHttpRequest,
  contentType: string | undefined
): Promise<NetworkProbeBody | undefined> {
  if (xhr.responseType && xhr.responseType !== "text" && xhr.responseType !== "json") {
    return {
      disposition: "omitted",
      ...(contentType ? { mimeType: contentType } : {}),
      reason: `XHR responseType ${xhr.responseType} is not text-like.`
    };
  }

  try {
    if (xhr.responseType === "json") {
      return textToCapture(JSON.stringify(xhr.response), contentType ?? "application/json");
    }

    return textToCapture(xhr.responseText ?? "", contentType);
  } catch (error: unknown) {
    return {
      disposition: "unavailable",
      ...(contentType ? { mimeType: contentType } : {}),
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

async function bodyToCapture(body: BodyInit | Document | null | undefined): Promise<NetworkProbeBody | undefined> {
  if (body === undefined || body === null) {
    return undefined;
  }

  if (typeof body === "string") {
    return textToCapture(body);
  }

  if (body instanceof URLSearchParams) {
    return textToCapture(body.toString(), "application/x-www-form-urlencoded");
  }

  if (body instanceof FormData) {
    return textToCapture(
      JSON.stringify(
        Array.from(body.entries()).map(([name, value]) => [name, typeof value === "string" ? value : "blob"])
      ),
      "multipart/form-data"
    );
  }

  if (body instanceof Blob) {
    return textToCapture(await body.text(), body.type || undefined);
  }

  if (body instanceof ArrayBuffer) {
    return textToCapture(new TextDecoder().decode(body));
  }

  if (ArrayBuffer.isView(body)) {
    return textToCapture(new TextDecoder().decode(body));
  }

  return {
    disposition: "omitted",
    reason: "Request body type is not text-like."
  };
}

function textToCapture(value: string, mimeType?: string): NetworkProbeBody {
  const encoded = new TextEncoder().encode(value);

  if (encoded.byteLength <= captureLimit) {
    return {
      disposition: "captured",
      encoding: "utf8",
      ...(mimeType ? { mimeType } : {}),
      value,
      byteLength: encoded.byteLength
    };
  }

  const truncated = new TextDecoder().decode(encoded.slice(0, captureLimit));
  const truncatedLength = new TextEncoder().encode(truncated).byteLength;

  return {
    disposition: "truncated",
    encoding: "utf8",
    ...(mimeType ? { mimeType } : {}),
    value: truncated,
    byteLength: encoded.byteLength,
    omittedByteLength: Math.max(0, encoded.byteLength - truncatedLength),
    reason: `Body exceeded ${captureLimit} bytes and was truncated locally.`
  };
}

function headersToEntries(headers: Headers): Array<{ name: string; value: string }> {
  return Array.from(headers.entries()).map(([name, value]) => ({ name, value }));
}

function parseRawHeaders(rawHeaders: string): Array<{ name: string; value: string }> {
  return rawHeaders
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      const separatorIndex = line.indexOf(":");

      if (separatorIndex <= 0) {
        return [];
      }

      return [
        {
          name: line.slice(0, separatorIndex).trim(),
          value: line.slice(separatorIndex + 1).trim()
        }
      ];
    });
}

function headerValue(headers: Array<{ name: string; value: string }>, name: string): string | undefined {
  return headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value;
}

function isTextLikeContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return true;
  }

  return /^(text\/|application\/(json|xml|x-www-form-urlencoded|graphql)|[^;]+\+json)/i.test(contentType);
}
