// Thin wrapper around fetch() for /api/* endpoints. Always sends/receives
// JSON and the session cookie (credentials: 'same-origin' is default but
// stated explicitly for clarity).
const API = {
  async _req(method, path, body) {
    const opts = { method, headers: {}, credentials: "same-origin" };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    const ct = res.headers.get("Content-Type") || "";
    if (ct.includes("text/csv")) return res; // caller handles blob
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok || data.ok === false) {
      const e = new Error(data.error || `অনুরোধ ব্যর্থ হয়েছে (${res.status})`);
      e.status = res.status;
      e.data = data;
      throw e;
    }
    return data;
  },
  get(path) { return this._req("GET", path); },
  post(path, body) { return this._req("POST", path, body ?? {}); },
  put(path, body) { return this._req("PUT", path, body ?? {}); },
  del(path) { return this._req("DELETE", path); },
};
