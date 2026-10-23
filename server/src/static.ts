// Serves the browser client straight from the repo. TypeScript files (the client and the shared
// rules) are converted to JavaScript on the fly with Node's built-in type stripping, so there is
// no build step and no bundler: edit a .ts file, refresh the browser.

import { readFile, stat } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { extname, join, normalize, sep } from "node:path";
import type { ServerResponse } from "node:http";

const PUBLIC_DIRS = ["client", "shared"];
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

const tsCache = new Map<string, { mtimeMs: number; js: string }>();

export async function serveStatic(rootDir: string, pathname: string, res: ServerResponse): Promise<void> {
  const rel = pathname === "/" ? "client/index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = normalize(join(rootDir, rel));
  const allowed = PUBLIC_DIRS.some((d) => file.startsWith(join(rootDir, d) + sep));
  const type = TYPES[extname(file)];
  if (!allowed || !type || file.includes(`${sep}test${sep}`)) return notFound(res);

  let info;
  try {
    info = await stat(file);
  } catch {
    return notFound(res);
  }
  if (!info.isFile()) return notFound(res);

  let body: string | Buffer;
  if (file.endsWith(".ts")) {
    const cached = tsCache.get(file);
    if (cached && cached.mtimeMs === info.mtimeMs) body = cached.js;
    else {
      const js = stripTypeScriptTypes(await readFile(file, "utf8"), { mode: "strip" });
      tsCache.set(file, { mtimeMs: info.mtimeMs, js });
      body = js;
    }
  } else {
    body = await readFile(file);
  }
  res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
}
