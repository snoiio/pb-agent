import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const query = searchParams.get("q")?.trim() ?? "";

  const rows = query
    ? await sql`
        SELECT id, fact, created_at, updated_at
        FROM memories
        WHERE fact ILIKE ${"%" + query + "%"}
        ORDER BY updated_at DESC
      `
    : await sql`
        SELECT id, fact, created_at, updated_at
        FROM memories
        ORDER BY updated_at DESC
      `;

  return Response.json(rows);
}

export async function PATCH(req: Request) {
  const { id, fact } = await req.json();

  if (!Number.isInteger(id) || typeof fact !== "string" || !fact.trim()) {
    return Response.json({ error: "Invalid memory." }, { status: 400 });
  }

  const rows = await sql`
    UPDATE memories
    SET fact = ${fact.trim()}, updated_at = NOW()
    WHERE id = ${id}
    RETURNING id, fact, created_at, updated_at
  `;

  if (!rows.length) {
    return Response.json({ error: "Memory not found." }, { status: 404 });
  }

  return Response.json(rows[0]);
}

export async function DELETE(req: Request) {
  const { id } = await req.json();

  if (!Number.isInteger(id)) {
    return Response.json({ error: "Invalid memory ID." }, { status: 400 });
  }

  const rows = await sql`
    DELETE FROM memories
    WHERE id = ${id}
    RETURNING id
  `;

  if (!rows.length) {
    return Response.json({ error: "Memory not found." }, { status: 404 });
  }

  return Response.json({ deleted: true });
}
