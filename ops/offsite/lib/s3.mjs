// s3.mjs — the smallest S3 client that can prove a bucket is WORM.
//
// No SDK, no dependencies: a deploy shell is configuration, and pulling a few
// hundred packages into the one job that has to work on the worst day of the year
// is a bad trade. Everything here is node:crypto and fetch.
//
// It speaks plain S3, so it works against Backblaze B2, Wasabi, Scaleway, MinIO —
// anything with SigV4 and Object Lock. Nothing about it is Backblaze-specific
// except `discoverB2Endpoint`, which is opt-in.

import { createHash, createHmac } from "node:crypto";

const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
const hmac = (key, s) => createHmac("sha256", key).update(s, "utf8").digest();

// S3 wants RFC-3986, and encodeURIComponent leaves !'()* alone.
const enc = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = (p) => p.split("/").map(enc).join("/");

export class S3 {
  // endpoint: https://s3.<region>.example.com   (no bucket in it)
  // region:   derived from the endpoint host when it looks like s3.<region>.…
  // pathStyle: put the bucket in the path instead of the hostname. Needed for a
  //   local server (a bucket name is not a resolvable subdomain of 127.0.0.1),
  //   which is how this client is tested against a real Object Lock implementation.
  constructor({ endpoint, region, bucket, keyId, secret, pathStyle = false }) {
    if (!endpoint) throw new Error("s3: no endpoint");
    if (!bucket) throw new Error("s3: no bucket");
    if (!keyId || !secret) throw new Error("s3: no credentials");
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.bucket = bucket;
    this.keyId = keyId;
    this.secret = secret;
    this.pathStyle = pathStyle;
    const url = new URL(this.endpoint);
    this.region = region || (url.hostname.match(/^s3[.-]([a-z0-9-]+)\./)?.[1]) || "us-east-1";
    // Virtual-host style by default. Path style still works on most providers, but
    // B2 has deprecated it and a bucket name with a dot is the only case it helps.
    this.host = pathStyle ? url.host : `${bucket}.${url.host}`;
    this.base = `${url.protocol}//${this.host}`;
  }

  // key: "" addresses the bucket itself (used for ?object-lock and ?versioning).
  async send(method, key, { query = {}, headers = {}, body = null, expect = null } = {}) {
    const payload = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256hex(payload);

    const h = new Map();
    for (const [k, v] of Object.entries(headers)) if (v != null) h.set(k.toLowerCase(), String(v).trim());
    h.set("host", this.host);
    h.set("x-amz-content-sha256", payloadHash);
    h.set("x-amz-date", amzDate);

    const signedKeys = [...h.keys()].sort();
    const canonicalHeaders = signedKeys.map((k) => `${k}:${h.get(k)}\n`).join("");
    const signedHeaders = signedKeys.join(";");

    const canonicalQuery = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [enc(k), enc(String(v))])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");

    const rel = String(key || "").replace(/^\/+/, "");
    const canonicalUri = this.pathStyle
      ? "/" + enc(this.bucket) + (rel ? "/" + encPath(rel) : "")
      : "/" + encPath(rel);
    const canonicalRequest =
      `${method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(canonicalRequest)}`;
    let k = Buffer.from(`AWS4${this.secret}`, "utf8");
    for (const part of [dateStamp, this.region, "s3", "aws4_request"]) k = hmac(k, part);
    const signature = createHmac("sha256", k).update(stringToSign, "utf8").digest("hex");

    const url = `${this.base}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
    const res = await fetch(url, {
      method,
      headers: {
        ...Object.fromEntries(h),
        authorization:
          `AWS4-HMAC-SHA256 Credential=${this.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      body: method === "GET" || method === "HEAD" || payload.length === 0 ? undefined : payload,
    });

    if (expect && !expect.includes(res.status)) {
      const text = await res.text().catch(() => "");
      const err = new Error(`s3 ${method} ${key || "/"} → ${res.status} ${xmlTag(text, "Code") || ""} ${xmlTag(text, "Message") || text.slice(0, 300)}`);
      err.status = res.status;
      err.code = xmlTag(text, "Code") || "";
      throw err;
    }
    return res;
  }

  async putObject(key, body, { contentType = "application/octet-stream", lockMode = null, retainUntil = null } = {}) {
    const res = await this.send("PUT", key, {
      headers: {
        "content-type": contentType,
        ...(lockMode ? { "x-amz-object-lock-mode": lockMode } : {}),
        ...(retainUntil ? { "x-amz-object-lock-retain-until-date": retainUntil } : {}),
      },
      body,
      expect: [200],
    });
    return { versionId: res.headers.get("x-amz-version-id") || null, etag: res.headers.get("etag") || null };
  }

  // Object Lock can only be turned on AT CREATION on B2, MinIO and S3 alike, so a
  // bucket made without this header can never become WORM — it has to be replaced.
  async createBucket({ objectLock = true } = {}) {
    return this.send("PUT", "", {
      headers: objectLock ? { "x-amz-bucket-object-lock-enabled": "true" } : {},
      expect: [200, 409],
    });
  }

  async getObject(key, { versionId = null } = {}) {
    const res = await this.send("GET", key, { query: versionId ? { versionId } : {}, expect: [200] });
    return Buffer.from(await res.arrayBuffer());
  }

  // Cursor-paginated; returns [{key, size, lastModified}].
  async list(prefix, { delimiter = null } = {}) {
    const out = [];
    const prefixes = [];
    let token = null;
    for (;;) {
      const res = await this.send("GET", "", {
        query: { "list-type": 2, prefix, ...(delimiter ? { delimiter } : {}), ...(token ? { "continuation-token": token } : {}) },
        expect: [200],
      });
      const xml = await res.text();
      for (const c of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) || []) {
        out.push({ key: xmlTag(c, "Key"), size: Number(xmlTag(c, "Size") || 0), lastModified: xmlTag(c, "LastModified") });
      }
      for (const c of xml.match(/<CommonPrefixes>[\s\S]*?<\/CommonPrefixes>/g) || []) prefixes.push(xmlTag(c, "Prefix"));
      if (xmlTag(xml, "IsTruncated") !== "true") break;
      token = xmlTag(xml, "NextContinuationToken");
      if (!token) break;
    }
    return { objects: out, prefixes };
  }

  // { enabled, mode, days, years } — mode/days come from a bucket DEFAULT retention
  // rule, which is optional. `enabled` is the load-bearing bit.
  async objectLock() {
    const res = await this.send("GET", "", { query: { "object-lock": "" } });
    if (res.status !== 200) {
      const t = await res.text().catch(() => "");
      return { enabled: false, why: `${res.status} ${xmlTag(t, "Code") || t.slice(0, 200)}` };
    }
    const xml = await res.text();
    return {
      enabled: xmlTag(xml, "ObjectLockEnabled") === "Enabled",
      mode: xmlTag(xml, "Mode") || null,
      days: Number(xmlTag(xml, "Days") || 0) || null,
      years: Number(xmlTag(xml, "Years") || 0) || null,
    };
  }

  async versioning() {
    const res = await this.send("GET", "", { query: { versioning: "" }, expect: [200] });
    return xmlTag(await res.text(), "Status") || "Disabled";
  }

  async objectRetention(key, versionId = null) {
    const res = await this.send("GET", key, { query: { retention: "", ...(versionId ? { versionId } : {}) } });
    if (res.status !== 200) return null;
    const xml = await res.text();
    return { mode: xmlTag(xml, "Mode"), retainUntil: xmlTag(xml, "RetainUntilDate") };
  }

  // The whole point of this file. A permanent (version-addressed) delete is the one
  // operation Object Lock exists to refuse — an unversioned DELETE only writes a
  // delete marker and destroys nothing, so it proves nothing.
  //
  // → { denied: true }  the lock held AND the bytes are still there.
  // → { denied: false } THE OBJECT IS GONE. Never call this on anything you need.
  //
  // The status code is not the verdict. Providers disagree about which one a locked
  // delete earns (Backblaze answers 403 AccessDenied, MinIO 400 InvalidRequest), and
  // a 204 in a versioned bucket can mean "wrote a delete marker" rather than
  // "destroyed that version". So the question is settled by reading the version back
  // afterwards: survival is the property worth asserting, not the error code.
  async tryPermanentDelete(key, versionId) {
    const res = await this.send("DELETE", key, { query: { versionId } });
    const code = res.status === 204 ? "" : (xmlTag(await res.text().catch(() => ""), "Code") || "");
    const head = await this.send("HEAD", key, { query: { versionId } });
    return { denied: head.status === 200, survived: head.status === 200, status: res.status, code };
  }
}

function xmlTag(xml, tag) {
  const m = String(xml || "").match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : null;
}

// Backblaze's S3 endpoint is region-specific and the region is not knowable from
// the key alone, so ask. Saves a variable nobody can look up without logging in.
export async function discoverB2Endpoint(keyId, appKey) {
  const res = await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
    headers: { authorization: "Basic " + Buffer.from(`${keyId}:${appKey}`).toString("base64") },
  });
  if (!res.ok) throw new Error(`b2 authorize → ${res.status} (are B2_KEY_ID / B2_APPLICATION_KEY right?)`);
  const j = await res.json();
  const s3 = j?.apiInfo?.storageApi?.s3ApiUrl;
  if (!s3) throw new Error("b2 authorize returned no s3ApiUrl — this key may be bucket-scoped without S3 access");
  return s3;
}

export { xmlTag };
