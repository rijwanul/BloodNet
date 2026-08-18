// Client for the donor.bd central donor-username system.
// Auth: Authorization: Bearer <donorbd_api_key>

async function call(baseUrl, apiKey, path, body) {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }
  return { ok: res.ok, status: res.status, data };
}

export async function donorbdCheckAvailability(settings, slug) {
  const { donorbd_base_url: baseUrl, donorbd_api_key: apiKey } = settings;
  if (!baseUrl || !apiKey) return { configured: false, available: true };
  const { ok, data } = await call(baseUrl, apiKey, "/api/checkAvailability", { slug });
  return { configured: true, available: ok && data && data.available !== false };
}

export async function donorbdNewEntry(settings, { target, slug }) {
  const { donorbd_base_url: baseUrl, donorbd_api_key: apiKey } = settings;
  if (!baseUrl || !apiKey) return { configured: false, ok: true };
  const { ok, data } = await call(baseUrl, apiKey, "/api/newEntry", {
    target,
    slug,
    fullIframe: false,
    socialEnabled: false,
  });
  return { configured: true, ok, data };
}

export async function donorbdDeleteEntry(settings, slug) {
  const { donorbd_base_url: baseUrl, donorbd_api_key: apiKey } = settings;
  if (!baseUrl || !apiKey) return { configured: false, ok: true };
  const { ok, data } = await call(baseUrl, apiKey, "/api/deleteEntry", { slug });
  return { configured: true, ok, data };
}
