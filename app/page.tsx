'use client';

import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";

type Memory = {
  id: number;
  fact: string;
  created_at: string;
  updated_at: string;
};

type ToolEvent = {
  id: string;
  timestamp: string;
  name: string;
  summary: string;
  success: boolean;
};

type ResponseEvent = {
  id: string;
  timestamp: string;
  kind: "assistant-response";
  messageId: string;
  textLength: number;
  partTypes: string[];
  status: string;
  error: string | null;
  blank: boolean;
};

type LogEvent = ToolEvent | ResponseEvent;

const toolIcons: Record<string, string> = {
  remember: "🗄️",
  recall: "🔎",
  updateMemory: "✏️",
  forget: "🗑️",
};

export default function Chat() {
  const [input, setInput] = useState("");
  const [memoryNotice, setMemoryNotice] = useState<string | null>(null);
  const [memoryChanged, setMemoryChanged] = useState(false);
  const [toolChanged, setToolChanged] = useState(false);
  const [panel, setPanel] = useState<"memories" | "tools" | null>(null);

  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoryQuery, setMemoryQuery] = useState("");
  const [memoriesLoading, setMemoriesLoading] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const [toolEvents, setToolEvents] = useState<LogEvent[]>([]);
  const seenResponses = useRef(new Set<string>());

  const seenMemoryToolCalls = useRef(new Set<string>());
  const seenToolCalls = useRef(new Set<string>());
  const timeZone =
    typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : undefined;

  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      body: { timeZone },
    }),
  });
  const busy = status === "streaming" || status === "submitted";

  useEffect(() => {
    setMemoryChanged(window.localStorage.getItem("pb-memory-changed") === "true");
    setToolChanged(window.localStorage.getItem("pb-tool-changed") === "true");
  }, []);

  async function loadMemories(search = "") {
    setMemoriesLoading(true);
    try {
      const res = await fetch(`/api/memories?q=${encodeURIComponent(search)}`);
      if (!res.ok) throw new Error("Failed to load memories");
      setMemories(await res.json());
    } finally {
      setMemoriesLoading(false);
    }
  }

  function openMemories() {
    setPanel("memories");
    setMemoryChanged(false);
    window.localStorage.removeItem("pb-memory-changed");
  }

  function openTools() {
    setPanel("tools");
    setToolChanged(false);
    window.localStorage.removeItem("pb-tool-changed");
    try {
      const stored = JSON.parse(window.localStorage.getItem("pb-tool-log") ?? "[]");
      setToolEvents(Array.isArray(stored) ? stored : []);
    } catch {
      setToolEvents([]);
    }
  }

  useEffect(() => {
    if (panel !== "memories") return;
    const timer = window.setTimeout(() => loadMemories(memoryQuery), 250);
    return () => window.clearTimeout(timer);
  }, [memoryQuery, panel]);

  function showNotice(message: string) {
    setMemoryNotice(message);
    window.setTimeout(() => setMemoryNotice(null), 2500);
  }

  async function saveMemory(id: number) {
    const res = await fetch("/api/memories", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, fact: editText }),
    });
    if (!res.ok) return;
    setEditingId(null);
    await loadMemories(memoryQuery);
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
    await loadMemories(memoryQuery);
    showNotice("🗄️ Memory forgotten");
  }

  function clearToolLog() {
    if (!window.confirm("Clear the local tool log?")) return;
    window.localStorage.removeItem("pb-tool-log");
    setToolEvents([]);
  }

  function formatDate(value: string, seconds = false) {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: seconds ? "medium" : "short",
    }).format(new Date(value));
  }

  useEffect(() => {
    if (status !== "ready" && status !== "error") return;
    const assistant = [...messages].reverse().find((message) => message.role === "assistant");
    if (!assistant || seenResponses.current.has(assistant.id)) return;
    seenResponses.current.add(assistant.id);
    const textLength = assistant.parts.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0);
    const entry: ResponseEvent = {
      id: `response-${assistant.id}`,
      timestamp: new Date().toISOString(),
      kind: "assistant-response",
      messageId: assistant.id,
      textLength,
      partTypes: assistant.parts.map((part) => part.type),
      status,
      error: error?.message ?? null,
      blank: textLength === 0,
    };
    try {
      const stored = JSON.parse(window.localStorage.getItem("pb-tool-log") ?? "[]");
      const existing: LogEvent[] = Array.isArray(stored) ? stored : [];
      const updated = [entry, ...existing].slice(0, 50);
      window.localStorage.setItem("pb-tool-log", JSON.stringify(updated));
      if (panel === "tools") setToolEvents(updated);
    } catch {
      window.localStorage.setItem("pb-tool-log", JSON.stringify([entry]));
      if (panel === "tools") setToolEvents([entry]);
    }
    if (panel !== "tools") {
      window.localStorage.setItem("pb-tool-changed", "true");
      setToolChanged(true);
    }
  }, [messages, status, error, panel]);

  useEffect(() => {
    let notice: string | null = null;

    for (const message of messages) {
      for (const part of message.parts) {
        const toolPart = part as {
          type?: string;
          toolCallId?: string;
          state?: string;
          output?: unknown;
          input?: unknown;
        };

        if (
          toolPart.state !== "output-available" ||
          typeof toolPart.output !== "string" ||
          !toolPart.toolCallId
        ) {
          continue;
        }

        if (!seenToolCalls.current.has(toolPart.toolCallId) && toolPart.type?.startsWith("tool-")) {
          const name = toolPart.type.slice(5);
          const toolInput = toolPart.input as { keyword?: string } | undefined;
          let summary = "Tool completed";
          let success = true;

          if (name === "remember") summary = toolPart.output.startsWith("Memory created:") ? "Memory created" : toolPart.output;
          else if (name === "recall") summary = toolInput?.keyword ? `Searched memory for "${toolInput.keyword}"` : "Searched memory";
          else if (name === "updateMemory") summary = toolPart.output.startsWith("Memory updated:") ? "Memory updated" : toolPart.output;
          else if (name === "forget") summary = toolPart.output.startsWith("Memory deleted:") ? "Memory deleted" : toolPart.output;

          if (toolPart.output.startsWith("No memory with ID")) success = false;

          const entry: ToolEvent = {
            id: toolPart.toolCallId,
            timestamp: new Date().toISOString(),
            name,
            summary,
            success,
          };
          try {
            const existing = JSON.parse(window.localStorage.getItem("pb-tool-log") ?? "[]");
            const log = Array.isArray(existing) ? existing : [];
            window.localStorage.setItem("pb-tool-log", JSON.stringify([entry, ...log].slice(0, 50)));
          } catch {
            window.localStorage.setItem("pb-tool-log", JSON.stringify([entry]));
          }
          window.localStorage.setItem("pb-tool-changed", "true");
          if (panel === "tools") {
            setToolEvents(JSON.parse(window.localStorage.getItem("pb-tool-log") ?? "[]"));
          } else {
            setToolChanged(true);
          }
          seenToolCalls.current.add(toolPart.toolCallId);
        }

        if (seenMemoryToolCalls.current.has(toolPart.toolCallId)) continue;

        if (toolPart.type === "tool-remember" && toolPart.output.startsWith("Memory created:")) {
          notice = "🗄️ Memory saved";
        } else if (toolPart.type === "tool-updateMemory" && toolPart.output.startsWith("Memory updated:")) {
          notice = "🗄️ Memory updated";
        } else if (toolPart.type === "tool-forget" && toolPart.output.startsWith("Memory deleted:")) {
          notice = "🗄️ Memory forgotten";
        }

        if (notice) seenMemoryToolCalls.current.add(toolPart.toolCallId);
      }
    }

    if (!notice) return;

    window.localStorage.setItem("pb-memory-changed", "true");
    setMemoryChanged(true);
    setMemoryNotice(notice);
    const timer = window.setTimeout(() => setMemoryNotice(null), 2500);
    return () => window.clearTimeout(timer);
  }, [messages]);

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: 16, display: "flex", flexDirection: "column", height: "100dvh" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 style={{ fontSize: 20 }}>🍬 Princess Bubblegum</h1>
        <div style={{ display: "flex", alignItems: "center" }}>
          <button onClick={openTools} aria-label="View tool log" title="Tool log" style={{ background: "none", border: "none", color: "#eee", fontSize: 22, padding: 8, position: "relative" }}>
            🔧
            {toolChanged && <span aria-hidden="true" style={{ position: "absolute", top: 5, right: 4, width: 8, height: 8, borderRadius: "50%", background: "#e879a8", boxShadow: "0 0 0 2px #1a1a2e" }} />}
          </button>
          <button onClick={openMemories} aria-label="Browse memories" title="Memories" style={{ background: "none", border: "none", color: "#eee", fontSize: 22, padding: 8, position: "relative" }}>
            🗄️
            {memoryChanged && <span aria-hidden="true" style={{ position: "absolute", top: 5, right: 4, width: 8, height: 8, borderRadius: "50%", background: "#e879a8", boxShadow: "0 0 0 2px #1a1a2e" }} />}
          </button>
        </div>
      </div>

      {panel && (
        <div style={{ position: "fixed", inset: 0, zIndex: 900, background: "#1a1a2e", overflowY: "auto" }}>
          <main style={{ maxWidth: 640, margin: "0 auto", padding: 16, minHeight: "100dvh" }}>
            <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <button onClick={() => setPanel(null)} aria-label="Close" style={{ background: "none", border: "none", color: "#eee", fontSize: 22, padding: 0 }}>←</button>
                <h1 style={{ fontSize: 20, margin: 0 }}>{panel === "memories" ? "Memories" : "Tool Log"}</h1>
              </div>
              {panel === "memories" ? (
                <span style={{ opacity: 0.65, fontSize: 14 }}>{memories.length}</span>
              ) : (
                <button onClick={clearToolLog} disabled={toolEvents.length === 0} style={{ background: "none", border: "none", color: "#bbb", padding: 8 }}>Clear log</button>
              )}
            </header>

            {panel === "memories" ? (
              <>
                <input
                  value={memoryQuery}
                  onChange={(e) => setMemoryQuery(e.target.value)}
                  placeholder="Search memories…"
                  style={{ width: "100%", boxSizing: "border-box", padding: 12, borderRadius: 12, border: "none", background: "#2d2d44", color: "#eee", marginBottom: 12 }}
                />
                {memoriesLoading ? (
                  <div style={{ opacity: 0.6, padding: 12 }}>Loading memories…</div>
                ) : memories.length === 0 ? (
                  <div style={{ opacity: 0.6, padding: 12 }}>No memories found.</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {memories.map((memory) => (
                      <section key={memory.id} style={{ background: "#2d2d44", borderRadius: 14, padding: 14 }}>
                        {editingId === memory.id ? (
                          <>
                            <textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={4} style={{ width: "100%", boxSizing: "border-box", resize: "vertical", padding: 10, borderRadius: 10, border: "1px solid #555", background: "#1a1a2e", color: "#eee", font: "inherit" }} />
                            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
                              <button onClick={() => setEditingId(null)}>Cancel</button>
                              <button disabled={!editText.trim()} onClick={() => saveMemory(memory.id)}>Save</button>
                            </div>
                          </>
                        ) : (
                          <>
                            <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{memory.fact}</div>
                            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.6 }}>Updated {formatDate(memory.updated_at)}</div>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
                              <button onClick={() => setExpandedId(expandedId === memory.id ? null : memory.id)} style={{ background: "none", border: "none", color: "#bbb", padding: 0 }}>Details {expandedId === memory.id ? "▲" : "▼"}</button>
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
              </>
            ) : (
              <>
                <div style={{ fontSize: 12, opacity: 0.55, marginBottom: 12 }}>Stored only in this browser · latest 50 calls</div>
                {toolEvents.length === 0 ? (
                  <div style={{ opacity: 0.6, padding: 12 }}>No tool calls logged yet.</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {toolEvents.map((event) => (
                      <section key={event.id} style={{ background: "#2d2d44", borderRadius: 14, padding: 14 }}>
                        {"kind" in event ? (
                          <>
                            <div style={{ fontWeight: 700 }}>💬 Assistant Response {event.blank ? "· Blank" : ""}</div>
                            <div style={{ fontSize: 12, opacity: 0.55, marginTop: 6 }}>{formatDate(event.timestamp, true)}</div>
                            <div style={{ marginTop: 8, lineHeight: 1.5 }}>Browser text length: {event.textLength}</div>
                            <div style={{ lineHeight: 1.5 }}>Message parts: {JSON.stringify(event.partTypes)}</div>
                            <div style={{ lineHeight: 1.5 }}>Chat status: {event.status}</div>
                            <div style={{ lineHeight: 1.5 }}>Error: {event.error ?? "None reported"}</div>
                            <div style={{ fontSize: 12, opacity: 0.55, marginTop: 6, overflowWrap: "anywhere" }}>Message ID: {event.messageId}</div>
                          </>
                        ) : (
                          <>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                          <div style={{ fontWeight: 700 }}>{toolIcons[event.name] ?? "🔧"} {event.name}</div>
                          <div style={{ fontSize: 12, opacity: 0.55, textAlign: "right" }}>{formatDate(event.timestamp, true)}</div>
                        </div>
                        <div style={{ marginTop: 8, lineHeight: 1.4 }}>{event.summary}</div>
                        {!event.success && <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>Failed</div>}
                          </>
                        )}
                      </section>
                    ))}
                  </div>
                )}
              </>
            )}
          </main>
        </div>
      )}

      {memoryNotice && (
        <div style={{ position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", zIndex: 1000, padding: "8px 12px", borderRadius: 999, background: "#2d2d44", boxShadow: "0 4px 16px rgba(0,0,0,0.3)", fontSize: 14 }}>
          {memoryNotice}
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
        {messages.map((m) => (
          <div key={m.id} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", background: m.role === "user" ? "#4a3f8c" : "#2d2d44", borderRadius: 12, padding: "8px 12px", maxWidth: "85%", whiteSpace: "pre-wrap" }}>
            {m.parts.map((p, i) => (p.type === "text" ? <span key={i}>{p.text}</span> : null))}
          </div>
        ))}
        {busy && <div style={{ opacity: 0.6 }}>The Princess is thinking…</div>}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (input.trim() && !busy) {
            sendMessage({ text: input });
            setInput("");
          }
        }}
        style={{ display: "flex", gap: 8, marginTop: 8 }}
      >
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Tell the Princess something…" style={{ flex: 1, padding: 12, borderRadius: 12, border: "none", background: "#2d2d44", color: "#eee" }} />
        <button disabled={busy} style={{ padding: "0 16px", borderRadius: 12, border: "none", background: "#e879a8", color: "#1a1a2e", fontWeight: 700 }}>Send</button>
      </form>
    </div>
  );
}
