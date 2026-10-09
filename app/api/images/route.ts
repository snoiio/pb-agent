import { neon } from "@neondatabase/serverless";
import { del, issueSignedToken, presignUrl } from "@vercel/blob";

const sql = neon(process.env.DATABASE_URL!);
const categories = new Set(["personal", "scientific", "reference", "art", "other"]);

function validArchiveId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value.trim());
}

function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((tag) => tag.slice(0, 40));
}

function compactImage(row: any) {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    selfPortrait: row.self_portrait,
    category: row.category,
    tags: Array.isArray(row.tags) ? row.tags : [],
    notes: row.notes,
    width: row.width,
    height: row.height,
    model: row.model,
    contentType: row.content_type,
    byteSize: row.byte_size,
    createdAt: row.created_at,
  };
}

export async function POST(request: Request) {
  const body = await request.json();
  const action = typeof body?.action === "string" ? body.action : "";

  if (action === "search") {
    const query = typeof body.query === "string" ? body.query.trim().toLowerCase().slice(0, 200) : "";
    const category = typeof body.category === "string" && categories.has(body.category) ? body.category : null;
    const tags = cleanTags(body.tags).map((tag) => tag.toLowerCase());
    const selfPortrait = typeof body.selfPortrait === "boolean" ? body.selfPortrait : null;
    const limit = Number.isInteger(body.limit) ? Math.min(10, Math.max(1, body.limit)) : 10;

    try {
      const rows = await sql`
        SELECT id, title, prompt, self_portrait, category, tags, notes,
               width, height, model, content_type, byte_size, created_at
        FROM images
        ORDER BY created_at DESC
        LIMIT 200
      `;

      const filtered = rows.filter((row) => {
        if (category && row.category !== category) return false;
        if (selfPortrait !== null && row.self_portrait !== selfPortrait) return false;
        const rowTags = Array.isArray(row.tags) ? row.tags.map((tag: unknown) => String(tag).toLowerCase()) : [];
        if (tags.length && !tags.every((tag) => rowTags.includes(tag))) return false;
        if (query) {
          const haystack = [row.title, row.prompt, row.notes, row.category, ...rowTags]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        return true;
      }).slice(0, limit);

      return Response.json({ ok: true, images: filtered.map(compactImage) });
    } catch (error) {
      console.error("[PB images] search failed", { message: error instanceof Error ? error.message : "Unknown error" });
      return Response.json({ ok: false, error: "The image archive could not be searched." }, { status: 500 });
    }
  }

  if (action === "get") {
    if (!validArchiveId(body.id)) {
      return Response.json({ ok: false, error: "A valid archive ID is required." }, { status: 400 });
    }
    const id = body.id.trim();

    try {
      const rows = await sql`
        SELECT id, blob_path, title, prompt, self_portrait, category, tags, notes,
               width, height, model, content_type, byte_size, created_at
        FROM images
        WHERE id = ${id}
        LIMIT 1
      `;
      const image = rows[0];
      if (!image) return Response.json({ ok: false, error: `No archived image with ID ${id} exists.` }, { status: 404 });

      const validUntil = Date.now() + 5 * 60 * 1000;
      const token = await issueSignedToken({ pathname: image.blob_path, operations: ["get"], validUntil });
      const { presignedUrl } = await presignUrl(token, {
        pathname: image.blob_path,
        operation: "get",
        validUntil,
      });

      return Response.json({ ok: true, image: compactImage(image), presignedUrl });
    } catch (error) {
      console.error("[PB images] get failed", { id, message: error instanceof Error ? error.message : "Unknown error" });
      return Response.json({ ok: false, error: "The archived image could not be loaded." }, { status: 500 });
    }
  }

  if (action === "update") {
    if (!validArchiveId(body.id)) {
      return Response.json({ ok: false, error: "A valid archive ID is required." }, { status: 400 });
    }
    const id = body.id.trim();
    const hasTitle = typeof body.title === "string";
    const title = hasTitle ? body.title.trim().slice(0, 120) : "";
    const hasCategory = typeof body.category === "string";
    const category = hasCategory ? body.category.trim() : "";
    const hasTags = Array.isArray(body.tags);
    const tags = cleanTags(body.tags);
    const hasNotes = typeof body.notes === "string";
    const notes = hasNotes ? body.notes.trim().slice(0, 500) : "";

    if (hasCategory && !categories.has(category)) {
      return Response.json({ ok: false, error: "A valid archive category is required." }, { status: 400 });
    }
    if (!hasTitle && !hasCategory && !hasTags && !hasNotes) {
      return Response.json({ ok: false, error: "No archive fields were provided to update." }, { status: 400 });
    }

    try {
      const rows = await sql`
        UPDATE images
        SET title = CASE WHEN ${hasTitle} THEN ${title || null} ELSE title END,
            category = CASE WHEN ${hasCategory} THEN ${category || null} ELSE category END,
            tags = CASE WHEN ${hasTags} THEN ${JSON.stringify(tags)}::jsonb ELSE tags END,
            notes = CASE WHEN ${hasNotes} THEN ${notes || null} ELSE notes END
        WHERE id = ${id}
        RETURNING id, title, prompt, self_portrait, category, tags, notes,
                  width, height, model, content_type, byte_size, created_at
      `;
      if (!rows.length) return Response.json({ ok: false, error: `No archived image with ID ${id} exists.` }, { status: 404 });
      return Response.json({ ok: true, image: compactImage(rows[0]) });
    } catch (error) {
      console.error("[PB images] update failed", { id, message: error instanceof Error ? error.message : "Unknown error" });
      return Response.json({ ok: false, error: "The archived image metadata could not be updated." }, { status: 500 });
    }
  }

  if (action === "delete") {
    if (!validArchiveId(body.id)) {
      return Response.json({ ok: false, error: "A valid archive ID is required." }, { status: 400 });
    }
    const id = body.id.trim();

    try {
      const rows = await sql`SELECT id, blob_path, title FROM images WHERE id = ${id} LIMIT 1`;
      const image = rows[0];
      if (!image) return Response.json({ ok: false, error: `No archived image with ID ${id} exists.` }, { status: 404 });

      await del(image.blob_path);
      await sql`DELETE FROM images WHERE id = ${id}`;
      return Response.json({ ok: true, id, title: image.title });
    } catch (error) {
      console.error("[PB images] delete failed", { id, message: error instanceof Error ? error.message : "Unknown error" });
      return Response.json({ ok: false, error: "The archived image could not be deleted; its database record was retained." }, { status: 500 });
    }
  }

  return Response.json({ ok: false, error: "Unknown image archive action." }, { status: 400 });
}
