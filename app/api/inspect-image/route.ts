const VISION_MODEL = "qwen/qwen3.6-27b";
const MAX_IMAGE_DATA_URL_LENGTH = 3_500_000;

function extractTextContent(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;

  const text = content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const value = part as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? value.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();

  return text || null;
}

export async function POST(req: Request) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return Response.json({ ok: false, error: "Vision inspection is not configured." }, { status: 500 });
  }

  let body: { imageUrl?: unknown; focus?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl : "";
  const focus = typeof body.focus === "string" ? body.focus.trim().slice(0, 500) : "";

  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(imageUrl)) {
    return Response.json({ ok: false, error: "A valid image data URL is required." }, { status: 400 });
  }

  if (imageUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
    return Response.json({ ok: false, error: "The inspection copy is too large." }, { status: 413 });
  }

  const instruction = [
    "Examine this generated image and report only what is visibly present.",
    "Be concrete and concise. Describe the subjects, appearance, pose or action, setting, composition, important objects, visible text, and obvious rendering mistakes when relevant.",
    "Do not assume the image matches the intended prompt, and do not invent unseen details.",
    focus ? `Pay particular attention to this question from the viewer: ${focus}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: instruction },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
        temperature: 0.2,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(90000),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).replace(/[\r\n]+/g, " ").slice(0, 700);
      console.error("[PB vision] provider failure", { status: response.status, detail });
      return Response.json(
        { ok: false, error: `Vision provider returned HTTP ${response.status}${detail ? `: ${detail}` : ""}` },
        { status: 502 },
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const description = extractTextContent(payload.choices?.[0]?.message?.content);

    if (!description) {
      return Response.json({ ok: false, error: "The vision model returned no description." }, { status: 502 });
    }

    console.log("[PB vision] inspection complete", {
      model: VISION_MODEL,
      descriptionLength: description.length,
    });
    return Response.json({ ok: true, description });
  } catch (error) {
    console.error("[PB vision] request exception", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return Response.json({ ok: false, error: "Image inspection timed out or failed." }, { status: 502 });
  }
}
