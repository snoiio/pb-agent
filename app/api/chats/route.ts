import { neon } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";

const sql = neon(process.env.DATABASE_URL!);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MESSAGES = 500;
const MAX_TITLE_LENGTH = 80;

async function ensureChatTables() {
  await sql`
    CREATE TABLE IF NOT EXISTS chats (
      id UUID PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS chat_messages (
      chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      role TEXT NOT NULL,
      message JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (chat_id, message_id)
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS chat_messages_chat_created_idx
    ON chat_messages (chat_id, created_at)
  `;
}

function compactChat(row: any) {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validMessage(message: unknown): message is { id: string; role: string; parts: unknown[] } {
  if (!message || typeof message !== "object") return false;
  const value = message as { id?: unknown; role?: unknown; parts?: unknown };
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 200 &&
    typeof value.role === "string" &&
    ["user", "assistant", "system"].includes(value.role) &&
    Array.isArray(value.parts)
  );
}

export async function GET(request: Request) {
  await ensureChatTables();
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id")?.trim();

  if (!id) {
    const rows = await sql`
      SELECT id, title, created_at, updated_at
      FROM chats
      ORDER BY updated_at DESC
      LIMIT 100
    `;
    return Response.json({ ok: true, chats: rows.map(compactChat) });
  }

  if (!UUID_RE.test(id)) {
    return Response.json({ ok: false, error: "A valid chat ID is required." }, { status: 400 });
  }

  const chats = await sql`
    SELECT id, title, created_at, updated_at
    FROM chats
    WHERE id = ${id}
    LIMIT 1
  `;
  if (!chats.length) {
    return Response.json({ ok: false, error: "Chat not found." }, { status: 404 });
  }

  const rows = await sql`
    SELECT message
    FROM chat_messages
    WHERE chat_id = ${id}
    ORDER BY created_at ASC
  `;

  return Response.json({
    ok: true,
    chat: compactChat(chats[0]),
    messages: rows.map((row) => row.message),
  });
}

export async function POST() {
  await ensureChatTables();
  const id = randomUUID();
  const rows = await sql`
    INSERT INTO chats (id, title)
    VALUES (${id}, 'New chat')
    RETURNING id, title, created_at, updated_at
  `;
  return Response.json({ ok: true, chat: compactChat(rows[0]) });
}

export async function PUT(request: Request) {
  await ensureChatTables();

  let body: { id?: unknown; title?: unknown; messages?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim().slice(0, MAX_TITLE_LENGTH) : "";
  const messages = Array.isArray(body.messages) ? body.messages : null;

  if (!UUID_RE.test(id)) {
    return Response.json({ ok: false, error: "A valid chat ID is required." }, { status: 400 });
  }
  if (!title) {
    return Response.json({ ok: false, error: "A chat title is required." }, { status: 400 });
  }
  if (!messages || messages.length > MAX_MESSAGES || !messages.every(validMessage)) {
    return Response.json({ ok: false, error: "Invalid chat messages." }, { status: 400 });
  }

  const existing = await sql`SELECT id FROM chats WHERE id = ${id} LIMIT 1`;
  if (!existing.length) {
    return Response.json({ ok: false, error: "Chat not found." }, { status: 404 });
  }

  for (const message of messages) {
    const serialized = JSON.stringify(message);
    if (serialized.length > 250_000) {
      return Response.json({ ok: false, error: "One chat message is too large to persist." }, { status: 413 });
    }

    await sql`
      INSERT INTO chat_messages (chat_id, message_id, role, message)
      VALUES (${id}, ${message.id}, ${message.role}, ${serialized}::jsonb)
      ON CONFLICT (chat_id, message_id)
      DO UPDATE SET role = EXCLUDED.role, message = EXCLUDED.message
    `;
  }

  const rows = await sql`
    UPDATE chats
    SET title = ${title}, updated_at = NOW()
    WHERE id = ${id}
    RETURNING id, title, created_at, updated_at
  `;

  return Response.json({ ok: true, chat: compactChat(rows[0]) });
}

export async function DELETE(request: Request) {
  await ensureChatTables();

  let body: { id?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!UUID_RE.test(id)) {
    return Response.json({ ok: false, error: "A valid chat ID is required." }, { status: 400 });
  }

  const rows = await sql`
    DELETE FROM chats
    WHERE id = ${id}
    RETURNING id
  `;
  if (!rows.length) {
    return Response.json({ ok: false, error: "Chat not found." }, { status: 404 });
  }

  return Response.json({ ok: true, deleted: true, id });
}
