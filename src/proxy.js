/**
 * proxy.js — per-pane "view port": a pass-through proxy the shell frames
 * instead of the pane's own port, identical except that the two framing
 * headers are deleted. Nothing else is parsed, buffered, or rewritten.
 *
 * Rules (see SECURITY.md):
 *   - Binds 127.0.0.1 only; peer and Host are checked like the daemon's gate.
 *   - `Sec-Fetch-Site: cross-site` is rejected, so remote pages can't frame a
 *     pane through it — the protection the stripped header was providing.
 *   - The target is fixed at construction (its own pane). No request-derived
 *     routing, so it can never be used to reach anything else.
 *   - What was removed is declared in `Sidebranch-Removed-Headers`.
 */

import http from "node:http";
import net from "node:net";
import { isLoopbackAddress, isAllowedHostHeader } from "./security.js";

// Hop-by-hop headers are per-connection; forwarding them corrupts framing of
// the next hop's stream (double chunking, stale keep-alive promises).
const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "te", "trailer", "proxy-authorization", "proxy-authenticate"];

/** Returns { headers, removed[] } — a copy with the framing headers gone. */
export function stripFramingHeaders(headers) {
  const out = { ...headers };
  const removed = [];
  if (out["x-frame-options"] !== undefined) {
    delete out["x-frame-options"];
    removed.push("x-frame-options");
  }
  const csp = out["content-security-policy"];
  if (csp !== undefined) {
    const strip = (v) => {
      const kept = String(v).split(";").filter((d) => !/^\s*frame-ancestors\s/i.test(d) && d.trim() !== "");
      return kept.join(";").trim();
    };
    const values = Array.isArray(csp) ? csp : [csp];
    const stripped = values.map(strip);
    if (stripped.join() !== values.join()) {
      removed.push("content-security-policy frame-ancestors");
      const kept = stripped.filter((v) => v !== "");
      if (kept.length === 0) delete out["content-security-policy"];
      else out["content-security-policy"] = Array.isArray(csp) ? kept : kept[0];
    }
  }
  return { headers: out, removed };
}

export class FrameProxy {
  constructor({ port, targetPort }) {
    this.port = port;
    this.targetPort = targetPort;
    this.server = null;
    this.sockets = new Set();
  }

  gate(req, res) {
    if (!isLoopbackAddress(req.socket.remoteAddress)) { res.writeHead(403).end(); return false; }
    if (!isAllowedHostHeader(req.headers.host)) { res.writeHead(403).end("Host not allowed\n"); return false; }
    if (String(req.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") {
      res.writeHead(403).end("Cross-site requests are not allowed\n");
      return false;
    }
    return true;
  }

  handle(req, res) {
    if (!this.gate(req, res)) return;
    const headers = { ...req.headers };
    for (const h of HOP_BY_HOP) delete headers[h];
    const upstream = http.request({
      host: "127.0.0.1",
      port: this.targetPort,
      method: req.method,
      path: req.url,
      headers,
      // No keep-alive pool: pooled sockets outlive stop() and pin the event
      // loop; on loopback a fresh connection per request costs nothing.
      agent: false,
    }, (up) => {
      const { headers: outHeaders, removed } = stripFramingHeaders(up.headers);
      for (const h of HOP_BY_HOP) delete outHeaders[h];
      if (removed.length) outHeaders["sidebranch-removed-headers"] = removed.join(", ");
      res.writeHead(up.statusCode, up.statusMessage, outHeaders);
      up.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Pane server on :${this.targetPort} is not answering\n`);
    });
    req.pipe(upstream);
  }

  // Raw splice for websockets (HMR). The gate applies here too — upgrades are
  // where Host checks classically get forgotten.
  upgrade(req, socket, head) {
    const deny = (msg) => socket.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n${msg}\n`);
    if (!isLoopbackAddress(req.socket.remoteAddress)) return deny("Forbidden");
    if (!isAllowedHostHeader(req.headers.host)) return deny("Host not allowed");
    if (String(req.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") return deny("Cross-site requests are not allowed");

    const target = net.connect(this.targetPort, "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      target.write(lines.join("\r\n") + "\r\n\r\n");
      if (head?.length) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    // Either side going away takes the other with it. 'end' is in the list
    // because http.Server sockets allow half-open: a peer's FIN alone never
    // produces 'close', and a half-closed websocket is a dead websocket.
    const drop = () => { socket.destroy(); target.destroy(); };
    for (const s of [socket, target]) { s.on("error", drop); s.on("close", drop); s.on("end", drop); }
  }

  async start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head));
    // Long-lived SSE/HMR streams must not be reaped by the default 300s cap.
    this.server.requestTimeout = 0;
    this.server.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "127.0.0.1", resolve);
    });
    return this;
  }

  async stop() {
    for (const s of this.sockets) s.destroy();
    await new Promise((r) => this.server?.close(r));
  }
}
