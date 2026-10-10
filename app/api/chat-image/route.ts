import { get } from "@vercel/blob";

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Invalid image ID", { status: 400 });
  try {
    const result = await get("pb-chat/" + id + ".webp", { access: "private" });
    if (!result) return new Response("Image not found", { status: 404 });
    return new Response(result.stream, { headers: { "Content-Type": "image/webp", "Cache-Control": "private, max-age=3600" } });
  } catch {
    return new Response("Image unavailable", { status: 500 });
  }
}
