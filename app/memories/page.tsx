'use client';

import Link from "next/link";
import { useEffect, useState } from "react";

type Memory = {
  id: number;
  fact: string;
  created_at: string;
  updated_at: string;
};

export default function Memories() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadMemories(search = "") {
    setLoading(true);
    try {
      const res = await fetch(`/api/memories?q=${encodeURIComponent(search)}`);
      if (!res.ok) throw new Error("Failed to load memories");
      setMemories(await res.json());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => loadMemories(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  function showNotice(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 2500);
  }

  async function saveMemory(id: number) {
    const res = await fetch("/api/memories", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, fact: editText }),
    });
    if (!res.ok) return;
    setEditingId(null);
    await loadMemories(query);
    showNotice("🗄️ Memory updated");
  }

  async function deleteMemory(memory: Memory) {
    if (!window.confirm(`Delete this memory?\n\n"${memory.fact}"`)) return;

    const res = await fetch("/api/memories", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: memory.id }),
    });
    if (!res.ok) return;
    await loadMemories(query);
    showNotice("🗄️ Memory forgotten");
  }

  function formatDate(value: string) {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  }

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: 16, minHeight: "100dvh" }}>
      {notice && (
        <div style={{
          position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)",
          zIndex: 1000, padding: "8px 12px", borderRadius: 999,
          background: "#2d2d44", boxShadow: "0 4px 16px rgba(0,0,0,0.3)", fontSize: 14,
        }}>
          {notice}
        </div>
      )}

      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Link href="/" style={{ color: "#eee", textDecoration: "none", fontSize: 22 }}>←</Link>
          <h1 style={{ fontSize: 20, margin: 0 }}>Memories</h1>
        </div>
        <span style={{ opacity: 0.65, fontSize: 14 }}>{memories.length}</span>
      </header>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search memories…"
        style={{
          width: "100%", boxSizing: "border-box", padding: 12, borderRadius: 12,
          border: "none", background: "#2d2d44", color: "#eee", marginBottom: 12,
        }}
      />

      {loading ? (
        <div style={{ opacity: 0.6, padding: 12 }}>Loading memories…</div>
      ) : memories.length === 0 ? (
        <div style={{ opacity: 0.6, padding: 12 }}>No memories found.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {memories.map((memory) => (
            <section key={memory.id} style={{ background: "#2d2d44", borderRadius: 14, padding: 14 }}>
              {editingId === memory.id ? (
                <>
                  <textarea
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    rows={4}
                    style={{
                      width: "100%", boxSizing: "border-box", resize: "vertical",
                      padding: 10, borderRadius: 10, border: "1px solid #555",
                      background: "#1a1a2e", color: "#eee", font: "inherit",
                    }}
                  />
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
                    <button onClick={() => setEditingId(null)}>Cancel</button>
                    <button disabled={!editText.trim()} onClick={() => saveMemory(memory.id)}>Save</button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{memory.fact}</div>
                  <div style={{ marginTop: 10, fontSize: 12, opacity: 0.6 }}>
                    Updated {formatDate(memory.updated_at)}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
                    <button
                      onClick={() => setExpandedId(expandedId === memory.id ? null : memory.id)}
                      style={{ background: "none", border: "none", color: "#bbb", padding: 0 }}
                    >
                      Details {expandedId === memory.id ? "▲" : "▼"}
                    </button>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={() => { setEditingId(memory.id); setEditText(memory.fact); }}>✏️</button>
                      <button onClick={() => deleteMemory(memory)}>🗑️</button>
                    </div>
                  </div>
                  {expandedId === memory.id && (
                    <div style={{ borderTop: "1px solid #444", marginTop: 10, paddingTop: 10, fontSize: 12, opacity: 0.7, lineHeight: 1.6 }}>
                      <div>Memory ID: {memory.id}</div>
                      <div>Created: {formatDate(memory.created_at)}</div>
                      <div>Updated: {formatDate(memory.updated_at)}</div>
                    </div>
                  )}
                </>
              )}
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
