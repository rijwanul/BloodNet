// Uploads a base64 image to ImgBB and returns the display url + delete url.
export async function uploadToImgbb(apiKey, base64Image) {
  if (!apiKey) throw new Error("ImgBB API Key configured নেই");
  const form = new URLSearchParams();
  form.set("image", base64Image);
  const res = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    body: form,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.success) {
    throw new Error("ImgBB আপলোড ব্যর্থ হয়েছে");
  }
  return {
    url: data.data.display_url || data.data.url,
    deleteUrl: data.data.delete_url || null,
  };
}
