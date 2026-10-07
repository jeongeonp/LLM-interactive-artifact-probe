// Session recordings for /process-review, read from a Google Drive folder shared (Viewer) with
// the service account in serviceAccountKey.json. Videos are streamed through this server so the
// page's <video> is same-origin: seeking, timestamps and frame capture all work, and nothing is
// stored on disk. Drive API reads are free (quota only); see server.js for the routes.
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { fileURLToPath } from "url";
import { GoogleAuth } from "google-auth-library";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = path.join(__dirname, "serviceAccountKey.json");
export const VIDEO_FOLDER = process.env.VIDEO_FOLDER || "1c9kIrNwaPHIxSYF6hRlwxMmJkiP-bjTd";
const API = "https://www.googleapis.com/drive/v3/files";

// Locally: the key file. Deployed (Cloud Run ships without it, see .gcloudignore): the service's
// built-in credentials — then the Drive folder must also be shared with the Cloud Run service account.
let _client = null;
async function token() {
  _client ||= await new GoogleAuth({ ...(fs.existsSync(KEY) ? { keyFile: KEY } : {}), scopes: ["https://www.googleapis.com/auth/drive.readonly"] }).getClient();
  return (await _client.getAccessToken()).token; // cached + refreshed by the library
}

// File names look like "I14-relo.mp4", "S1-tool.vtt", "S06-relo.txt": pid (leading zeros
// dropped, so S06 = S6), then the scenario task. One recording covers the whole study session,
// i.e. both the scenario task and the userchoice task.
const TASK = { relo: "relocation", tool: "studytool" };
const parseName = (name) => {
  const m = String(name).match(/^([A-Za-z])0*(\d+)-([a-z]+)\.(mp4|mov|webm|vtt|txt)$/i);
  return m && { pid: m[1].toUpperCase() + m[2], task: TASK[m[3].toLowerCase()] || m[3].toLowerCase(), ext: m[4].toLowerCase() };
};

let _list = null; // { t, v: { videos: { pid -> {...} }, ids: Set } }
export async function listVideos(fresh) {
  if (_list && Date.now() - _list.t < 10 * 60 * 1000 && !fresh) return _list.v;
  const files = [];
  let pageToken;
  do {
    const u = new URL(API);
    u.search = new URLSearchParams({
      q: `'${VIDEO_FOLDER}' in parents and trashed=false`,
      fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,videoMediaMetadata)",
      pageSize: "1000", supportsAllDrives: "true", includeItemsFromAllDrives: "true", ...(pageToken ? { pageToken } : {}),
    });
    const r = await fetch(u, { headers: { Authorization: "Bearer " + (await token()) } });
    if (!r.ok) throw new Error(`Drive list ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    files.push(...j.files);
    pageToken = j.nextPageToken;
  } while (pageToken);
  const videos = {};
  for (const f of files) {
    const p = parseName(f.name);
    if (!p) continue;
    const v = (videos[p.pid] ||= { pid: p.pid, task: p.task });
    if (["mp4", "mov", "webm"].includes(p.ext)) {
      Object.assign(v, { name: f.name, videoId: f.id, size: +f.size || null, modifiedTime: f.modifiedTime,
        durationMs: +f.videoMediaMetadata?.durationMillis || null, width: f.videoMediaMetadata?.width, height: f.videoMediaMetadata?.height });
    } else if (p.ext === "vtt") v.vttId = f.id;
    else if (p.ext === "txt") v.txtId = f.id;
  }
  for (const k of Object.keys(videos)) if (!videos[k].videoId) delete videos[k];
  const ids = new Set(Object.values(videos).flatMap((v) => [v.videoId, v.vttId, v.txtId].filter(Boolean)));
  _list = { t: Date.now(), v: { videos, ids } };
  return _list.v;
}

// Stream one file (only ones listed in the folder) with Range passthrough. The upstream request
// is aborted when the browser drops the connection — it does that on every seek, and without the
// abort Drive would keep sending the rest of a ~500 MB file to nobody.
export async function streamFile(id, req, res) {
  const { ids } = await listVideos();
  if (!ids.has(id)) return res.status(404).send("not a session recording");
  const ac = new AbortController();
  res.on("close", () => ac.abort());
  const headers = { Authorization: "Bearer " + (await token()) };
  if (req.headers.range) headers.Range = req.headers.range;
  let r;
  try {
    r = await fetch(`${API}/${id}?alt=media&supportsAllDrives=true`, { headers, signal: ac.signal });
  } catch (e) {
    if (!ac.signal.aborted) res.status(502).send("Drive fetch failed");
    return;
  }
  res.status(r.status);
  for (const h of ["content-type", "content-length", "content-range", "last-modified", "etag"]) {
    const v = r.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=3600");
  if (!r.body) return res.end();
  Readable.fromWeb(r.body).on("error", () => res.destroy()).pipe(res);
}
