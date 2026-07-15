const port = Number(process.env.JITTLE_LAMP_RECORDING_FIXTURE_PORT ?? "4399");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, fixture: "jittle-lamp-recording" });
    }

    if (url.pathname === "/fixture.css") {
      return new Response(fixtureCss, { headers: { "content-type": "text/css; charset=utf-8" } });
    }

    if (url.pathname === "/fixture.js") {
      return new Response(fixtureJs, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    }

    if (url.pathname === "/fixture.svg") {
      return new Response(fixtureSvg, { headers: { "content-type": "image/svg+xml" } });
    }

    if (url.pathname === "/api/boot") {
      return Response.json({ ok: true, marker: "jl-fixture-boot" }, { headers: fixtureHeaders() });
    }

    if (url.pathname === "/api/data") {
      return Response.json(
        { ok: true, marker: "jl-fixture-fetch", items: ["video", "archive", "telemetry"] },
        { headers: fixtureHeaders() }
      );
    }

    if (url.pathname === "/api/xhr") {
      return Response.json({ ok: true, marker: "jl-fixture-xhr" }, { headers: fixtureHeaders() });
    }

    if (url.pathname === "/api/submit" && request.method === "POST") {
      return Response.json(
        { ok: true, marker: "jl-fixture-submit", body: await request.json() },
        { headers: fixtureHeaders() }
      );
    }

    if (url.pathname === "/api/expected-error") {
      return Response.json(
        { ok: false, marker: "jl-fixture-expected-error" },
        { status: 418, headers: fixtureHeaders() }
      );
    }

    return new Response(fixtureHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
});

console.info(`Recording fixture ready at ${server.url}?run=full-assets#start`);

function fixtureHeaders(): Headers {
  return new Headers({
    "content-type": "application/json; charset=utf-8",
    "x-jittle-lamp-fixture": "full-assets"
  });
}

const fixtureHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Jittle Lamp Recording Fixture</title>
    <link rel="stylesheet" href="/fixture.css" />
    <script type="module" src="/fixture.js"></script>
  </head>
  <body>
    <main>
      <section class="hero">
        <div>
          <p class="eyebrow">LOCAL RECORDING TEST</p>
          <h1>Full asset capture</h1>
          <p>Record this page. Run the test. Finish the recording.</p>
        </div>
        <img src="/fixture.svg" alt="Moving fixture marker" />
      </section>
      <canvas id="motion" width="960" height="260" aria-label="Animated recording content"></canvas>
      <form id="fixture-form">
        <label>Name <input id="fixture-name" name="name" value="" autocomplete="off" /></label>
        <label>Mode
          <select id="fixture-mode" name="mode">
            <option value="basic">Basic</option>
            <option value="full">Full assets</option>
          </select>
        </label>
        <label><input id="fixture-check" name="confirmed" type="checkbox" /> Confirm</label>
        <button id="submit-fixture" type="submit">Submit form</button>
      </form>
      <div class="actions">
        <button id="enable-audio" type="button">Enable test audio</button>
        <button id="run-fixture" type="button">Run full asset test</button>
        <button id="navigate-fixture" type="button">Test navigation</button>
      </div>
      <pre id="result" role="status">Ready.</pre>
    </main>
  </body>
</html>`;

const fixtureCss = `
:root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; background: #08111f; color: #e5efff; }
body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top right, #17345f, #08111f 50%); }
main { width: min(980px, calc(100% - 48px)); margin: 36px auto; }
.hero { display: flex; align-items: center; justify-content: space-between; }
.hero img { width: 120px; animation: float 1.5s ease-in-out infinite alternate; }
.eyebrow { color: #62d9ff; letter-spacing: .18em; font-weight: 800; }
h1 { margin: 8px 0; font-size: 48px; }
canvas { width: 100%; border: 1px solid #33547e; border-radius: 18px; background: #0c1b30; }
form, .actions { display: flex; gap: 18px; align-items: end; margin-top: 22px; padding: 20px; border-radius: 16px; background: #10223d; }
label { display: grid; gap: 8px; }
input, select, button { font: inherit; color: inherit; border: 1px solid #4973a6; border-radius: 9px; background: #0b1728; padding: 10px 14px; }
button { cursor: pointer; background: #175f8b; font-weight: 750; }
pre { min-height: 48px; padding: 16px; white-space: pre-wrap; color: #97edb6; }
@keyframes float { to { transform: translate(-24px, 12px) rotate(-8deg); } }
`;

const fixtureSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#62d9ff"/><stop offset="1" stop-color="#8d6bff"/></linearGradient></defs>
  <rect x="8" y="8" width="104" height="104" rx="28" fill="url(#g)"/>
  <circle cx="60" cy="60" r="27" fill="#08111f"/><path d="M52 43 79 60 52 77Z" fill="#fff"/>
</svg>`;

const fixtureJs = `
const result = document.querySelector("#result");
const canvas = document.querySelector("#motion");
const context = canvas.getContext("2d");
let frame = 0;

function draw() {
  frame += 1;
  const hue = frame % 360;
  context.fillStyle = "hsl(" + hue + " 42% 13%)";
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < 7; index += 1) {
    const x = (frame * (2 + index * 0.3) + index * 140) % (canvas.width + 100) - 50;
    const y = 45 + index * 28;
    context.fillStyle = "hsl(" + ((hue + index * 41) % 360) + " 82% 64%)";
    context.beginPath();
    context.arc(x, y, 18 + index, 0, Math.PI * 2);
    context.fill();
  }
  context.fillStyle = "white";
  context.font = "700 28px system-ui";
  context.fillText("Recording frame " + frame, 28, 42);
  requestAnimationFrame(draw);
}
draw();

console.info("jl-fixture:page-ready", { marker: "jl-fixture-console-info" });
fetch("/api/boot").then((response) => response.json()).then((data) => {
  result.textContent = "Boot request: " + data.marker;
});

document.querySelector("#enable-audio").addEventListener("click", () => {
  const audio = new AudioContext();
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = 220;
  gain.gain.value = 0.015;
  oscillator.connect(gain).connect(audio.destination);
  oscillator.start();
  result.textContent = "Test audio is active.";
});

document.querySelector("#run-fixture").addEventListener("click", async () => {
  console.warn("jl-fixture:console-warning");
  console.error("jl-fixture:console-error");
  const fetchResult = await fetch("/api/data?marker=jl-fixture-fetch").then((response) => response.json());
  const expectedError = await fetch("/api/expected-error?marker=jl-fixture-error");
  const xhrResult = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "/api/xhr?marker=jl-fixture-xhr");
    xhr.onload = () => resolve(JSON.parse(xhr.responseText));
    xhr.onerror = reject;
    xhr.send();
  });
  result.textContent = JSON.stringify({ fetchResult, xhrResult, expectedStatus: expectedError.status }, null, 2);
});

document.querySelector("#navigate-fixture").addEventListener("click", () => {
  history.pushState({}, "", "/recording-fixture/step?private=removed#captured-navigation");
  result.textContent = "Navigation event sent.";
});

document.querySelector("#fixture-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = { name: form.get("name"), mode: form.get("mode"), confirmed: form.has("confirmed") };
  const response = await fetch("/api/submit?marker=jl-fixture-submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  result.textContent = JSON.stringify(await response.json(), null, 2);
});
`;
