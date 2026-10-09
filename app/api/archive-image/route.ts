import { neon } from "@neondatabase/serverless";
import { del } from "@vercel/blob";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

const sql = neon(process.env.DATABASE_URL!);

const categories = new Set(["personal", "scientific", "reference", "art", "other"]);

async function ensureImageArchiveTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      blob_path TEXT NOT NULL UNIQUE,
      title TEXT,
      prompt TEXT NOT NULL,
      effective_prompt TEXT,
      self_portrait BOOLEAN NOT NULL DEFAULT FALSE,
      category TEXT NOT NULL,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      notes TEXT,
      width INTEGER,
      height INTEGER,
      model TEXT,
      content_type TEXT,
      byte_size INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT images_category_check CHECK (category IN ('personal', 'scientific', 'reference', 'art', 'other'))
    )
  `;
}

export async function POST(request: Request) {
  const body = await request.json();

  if (body?.action === "finalize") {
    const archiveId = typeof body.archiveId === "string" ? body.archiveId.trim() : "";
    const blobPath = typeof body.blobPath === "string" ? body.blobPath.trim() : "";
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 120) : "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 1800) : "";
    const effectivePrompt = typeof body.effectivePrompt === "string" ? body.effectivePrompt.trim().slice(0, 2200) : "";
    const selfPortrait = body.selfPortrait === true;
    const category = typeof body.category === "string" ? body.category.trim() : "";
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((tag: unknown): tag is string => typeof tag === "string").map((tag: string) => tag.trim()).filter(Boolean).slice(0, 12).map((tag: string) => tag.slice(0, 40))
      : [];
    const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 500) : "";
    const width = Number.isInteger(body.width) ? body.width : null;
    const height = Number.isInteger(body.height) ? body.height : null;
    const model = typeof body.model === "string" ? body.model.trim().slice(0, 120) : "";
    const contentType = typeof body.contentType === "string" ? body.contentType.trim().slice(0, 100) : "";
    const byteSize = Number.isInteger(body.byteSize) ? body.byteSize : null;

    if (!archiveId || !/^[0-9a-f-]{36}$/i.test(archiveId)) {
      return Response.json({ ok: false, error: "A valid archive ID is required." }, { status: 400 });
    }
    if (!blobPath.startsWith("pb-archive/")) {
      return Response.json({ ok: false, error: "A valid archive Blob path is required." }, { status: 400 });
    }
    if (!prompt) {
      return Response.json({ ok: false, error: "The original image prompt is required." }, { status: 400 });
    }
    if (!categories.has(category)) {
      return Response.json({ ok: false, error: "A valid archive category is required." }, { status: 400 });
    }

    try {
      await ensureImageArchiveTable();
      const rows = await sql`
        INSERT INTO images (
          id, blob_path, title, prompt, effective_prompt, self_portrait,
          category, tags, notes, width, height, model, content_type, byte_size
        )
        VALUES (
          ${archiveId}, ${blobPath}, ${title || null}, ${prompt}, ${effectivePrompt || null}, ${selfPortrait},
          ${category}, ${JSON.stringify(tags)}::jsonb, ${notes || null}, ${width}, ${height}, ${model || null}, ${contentType || null}, ${byteSize}
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING id, category, created_at
      `;

      const archived = rows[0];
      if (!archived) {
        await del(blobPath).catch(() => undefined);
        return Response.json({ ok: false, error: "That archive ID already exists." }, { status: 409 });
      }

      console.log("[PB archive] finalized", {
        archiveId,
        category,
        selfPortrait,
        width,
        height,
        byteSize,
      });

      return Response.json({
        ok: true,
        archiveId: archived.id,
        category: archived.category,
        createdAt: archived.created_at,
      });
    } catch (error) {
      await del(blobPath).catch((cleanupError) => {
        console.error("[PB archive] orphan cleanup failed", {
          blobPath,
          message: cleanupError instanceof Error ? cleanupError.message : "Unknown error",
        });
      });
      console.error("[PB archive] finalize failed", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
      return Response.json({ ok: false, error: "The archive record could not be saved, so the uploaded image was discarded." }, { status: 500 });
    }
  }

  try {
    const jsonResponse = await handleUpload({
      body: body as HandleUploadBody,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith("pb-archive/")) {
          throw new Error("Invalid archive pathname.");
        }

        return {
          allowedContentTypes: ["image/png", "image/jpeg", "image/webp"],
          addRandomSuffix: true,
        };
      },
      onUploadCompleted: async ({ blob }) => {
        console.log("[PB archive] blob upload completed", {
          pathname: blob.pathname,
          contentType: blob.contentType,
        });
      },
    });

    return Response.json(jsonResponse);
  } catch (error) {
    console.error("[PB archive] upload token error", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return Response.json({ error: error instanceof Error ? error.message : "Archive upload failed." }, { status: 400 });
  }
}
