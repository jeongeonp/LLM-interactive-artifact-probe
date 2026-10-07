// Service worker for /process-review: streams session recordings straight from Google Drive to this
// browser (Range requests, with a short-lived read-only token from the server), so the video bytes
// never pass through — and aren't billed as egress by — the server. Only /api/drive/<id>?s=<size>
// requests are handled; anything unexpected falls back to the server proxy at the same URL.
const API = "https://www.googleapis.com/drive/v3/files/";
let tok = null; // { token, expires }

async function token() {
  if (tok && tok.expires - Date.now() > 5 * 60e3) return tok.token;
  const r = await fetch("/api/drive-token", { credentials: "same-origin" });
  if (!r.ok) throw new Error("token " + r.status);
  tok = await r.json();
  return tok.token;
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  const m = u.origin === location.origin && u.pathname.match(/^\/api\/drive\/([\w-]+)$/);
  const size = +u.searchParams.get("s");
  if (!m || !size || e.request.method !== "GET") return;
  e.respondWith(direct(e.request, m[1], size).catch(() => fetch(e.request)));
});

// Drive's CORS response doesn't expose Content-Range, so it's rebuilt from the requested start,
// the returned length and the file size (passed in the URL).
async function direct(req, id, size) {
  const headers = { Authorization: "Bearer " + (await token()) };
  const range = req.headers.get("range");
  if (range) headers.Range = range;
  const r = await fetch(`${API}${id}?alt=media&supportsAllDrives=true`, { headers, signal: req.signal });
  if (r.status !== 200 && r.status !== 206) throw new Error(String(r.status));
  const len = +r.headers.get("content-length");
  const h = { "Content-Type": r.headers.get("content-type") || "video/mp4", "Accept-Ranges": "bytes" };
  if (len) h["Content-Length"] = String(len);
  if (r.status === 206) {
    const start = +((/bytes=(\d+)-/.exec(range || "") || [])[1] || 0);
    h["Content-Range"] = `bytes ${start}-${start + len - 1}/${size}`;
  }
  return new Response(r.body, { status: r.status, headers: h });
}
