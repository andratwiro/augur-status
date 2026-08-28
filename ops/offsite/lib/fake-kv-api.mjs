// A stand-in for the Cloudflare KV REST API, good enough to drive kv-export.mjs and
// restore-kv.mjs end to end without an account or a network.
//
// It stores BYTES, because that is what KV stores, and it is deliberately strict about
// the two things that carry them: `GET /values/<key>` answers the raw bytes with no
// charset, and `PUT /bulk` accepts `base64: true` per pair and REFUSES a non-string
// value. Both are what the real endpoint does, and both are what a text-mode caller gets
// wrong — a lenient double would let the bug back in and call it a passing test.
//
// Test-only. Nothing in the backup path imports it.

import { createServer } from "node:http";

export async function startFakeKvApi(initial = new Map()) {
  const store = new Map(initial);
  const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const m = /\/namespaces\/([^/]+)\/(keys|bulk|values\/(.+))$/.exec(url.pathname);
    if (!m) return json(res, 404, { success: false, errors: [{ message: "no such route" }] });

    if (m[2] === "keys") {
      return json(res, 200, { success: true, result: [...store.keys()].map((name) => ({ name })), result_info: {} });
    }

    if (m[2] === "bulk" && req.method === "PUT") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
        return json(res, 400, { success: false, errors: [{ message: "bad json" }] });
      }
      for (const p of body) {
        if (typeof p.value !== "string") {
          // The real endpoint takes a string. Sending it an object is how a caller that
          // does not understand the marker would fail — loudly, which is the point.
          return json(res, 400, { success: false, errors: [{ message: `value for ${p.key} is not a string` }] });
        }
        store.set(p.key, p.base64 ? Buffer.from(p.value, "base64") : Buffer.from(p.value, "utf8"));
      }
      return json(res, 200, { success: true, result: null });
    }

    if (m[3] !== undefined && req.method === "GET") {
      const v = store.get(decodeURIComponent(m[3]));
      if (v === undefined) return json(res, 404, { success: false, errors: [{ message: "key not found" }] });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(v);
    }
    return json(res, 405, { success: false, errors: [{ message: "method not allowed" }] });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    store,
    base: `http://127.0.0.1:${server.address().port}/client/v4`,
    close: () => new Promise((r) => server.close(r)),
  };
}
