// Fixture web app for runner tests: login form → dashboard with an account menu → sign out.
// Credentials come from the caller; the server never prints them.

export type FixtureApp = { url: string; stop: () => void; requests: string[] };

const page = (title: string, body: string, script = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:40px}form{display:grid;gap:12px;max-width:320px}nav{display:flex;justify-content:space-between}[role=menu]{border:1px solid #ccc;padding:8px}</style>
</head><body>${body}<script>${script}</script></body></html>`;

const loginPage = page(
  "Sign in",
  `<main><h1>Sign in</h1><form id="login">
  <label>Email <input name="email" type="email" autocomplete="off"></label>
  <label>Password <input name="password" type="password" autocomplete="off"></label>
  <button type="submit">Sign in</button><p role="alert" id="error"></p></form></main>`,
  `document.getElementById("login").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const response = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: form.get("email"), password: form.get("password") }) });
    if (response.ok) { console.info("login ok"); location.href = "/dashboard"; }
    else { document.getElementById("error").textContent = "Wrong email or password"; console.warn("login rejected"); }
  });`
);

const dashboardPage = page(
  "Dashboard",
  `<header><nav><strong>Fixture School</strong><button id="menu" aria-haspopup="menu" aria-expanded="false">Account menu</button></nav>
  <div role="menu" id="menuList" hidden><button role="menuitem" id="signout">Sign out</button></div></header>
  <main><h1>Welcome, HQ admin</h1><p>Classes today: 4</p></main>`,
  `const menu = document.getElementById("menu"); const list = document.getElementById("menuList");
  menu.addEventListener("click", () => { list.hidden = !list.hidden; menu.setAttribute("aria-expanded", String(!list.hidden)); });
  document.getElementById("signout").addEventListener("click", async () => { await fetch("/api/logout", { method: "POST" }); console.info("signed out"); location.href = "/login"; });
  fetch("/api/summary").then((r) => r.json()).then((data) => console.info("summary", data.classes));`
);

export function startFixtureApp(credentials: { email: string; password: string }): FixtureApp {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      const signedIn = (request.headers.get("cookie") ?? "").includes("session=ok");
      const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (url.pathname === "/") return Response.redirect(new URL(signedIn ? "/dashboard" : "/login", url), 302);
      if (url.pathname === "/login") return html(loginPage);
      if (url.pathname === "/dashboard") return signedIn ? html(dashboardPage) : Response.redirect(new URL("/login", url), 302);
      if (url.pathname === "/api/login" && request.method === "POST") {
        const body = (await request.json()) as { email?: string; password?: string };
        if (body.email === credentials.email && body.password === credentials.password) {
          return new Response(JSON.stringify({ ok: true }), { headers: { "set-cookie": "session=ok; Path=/; HttpOnly", "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ ok: false }), { status: 401, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/api/logout") return new Response(null, { status: 204, headers: { "set-cookie": "session=; Path=/; Max-Age=0" } });
      if (url.pathname === "/api/summary") return Response.json({ classes: 4 });
      return new Response("not found", { status: 404 });
    }
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true), requests };
}

if (import.meta.main) {
  const app = startFixtureApp({ email: process.env.FIXTURE_EMAIL ?? "admin@example.test", password: process.env.FIXTURE_PASSWORD ?? "fixture-Pa55word!" });
  console.log(app.url);
}
