'use client';

import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import Link from "next/link";
import { DefaultChatTransport } from "ai";

export default function Chat() {
  const [input, setInput] = useState("");
  const [memoryNotice, setMemoryNotice] = useState<string | null>(null);
  const [memoryChanged, setMemoryChanged] = useState(false);
  const seenMemoryToolCalls = useRef(new Set<string>());
  const timeZone =
    typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : undefined;

  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      body: { timeZone },
    }),
  });
  const busy = status === "streaming" || status === "submitted";

  useEffect(() => {
    setMemoryChanged(window.localStorage.getItem("pb-memory-changed") === "true");
  }, []);

  useEffect(() => {
    let notice: string | null = null;

    for (const message of messages) {
      for (const part of message.parts) {
        const toolPart = part as {
          type?: string;
          toolCallId?: string;
          state?: string;
          output?: unknown;
        };

        if (
          toolPart.state !== "output-available" ||
          typeof toolPart.output !== "string" ||
          !toolPart.toolCallId ||
          seenMemoryToolCalls.current.has(toolPart.toolCallId)
        ) {
          continue;
        }

        if (
          toolPart.type === "tool-remember" &&
          toolPart.output.startsWith("Memory created:")
        ) {
          notice = "🗄️ Memory saved";
        } else if (
          toolPart.type === "tool-updateMemory" &&
          toolPart.output.startsWith("Memory updated:")
        ) {
          notice = "🗄️ Memory updated";
        } else if (
          toolPart.type === "tool-forget" &&
          toolPart.output.startsWith("Memory deleted:")
        ) {
          notice = "🗄️ Memory forgotten";
        }

        if (notice) {
          seenMemoryToolCalls.current.add(toolPart.toolCallId);
        }
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
        <Link
          href="/memories"
          aria-label="Browse memories"
          title="Memories"
          style={{ color: "#eee", textDecoration: "none", fontSize: 22, padding: 8, position: "relative", display: "inline-block" }}
        >
          🗄️
          {memoryChanged && (
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                top: 5,
                right: 4,
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#e879a8",
                boxShadow: "0 0 0 2px #1a1a2e",
              }}
            />
          )}
        </Link>
      </div>
      {memoryNotice && (
        <div
          style={{
            position: "fixed",
            top: 16,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 1000,
            padding: "8px 12px",
            borderRadius: 999,
            background: "#2d2d44",
            boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
            fontSize: 14,
          }}
        >
          {memoryNotice}
        </div>
      )}
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
        {messages.map((m) => (
          <div key={m.id} style={{
            alignSelf: m.role === "user" ? "flex-end" : "flex-start",
            background: m.role === "user" ? "#4a3f8c" : "#2d2d44",
            borderRadius: 12, padding: "8px 12px", maxWidth: "85%", whiteSpace: "pre-wrap",
          }}>
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
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Tell the Princess something…"
          style={{ flex: 1, padding: 12, borderRadius: 12, border: "none", background: "#2d2d44", color: "#eee" }}
        />
        <button disabled={busy} style={{ padding: "0 16px", borderRadius: 12, border: "none", background: "#e879a8", color: "#1a1a2e", fontWeight: 700 }}>
          Send
        </button>
      </form>
    </div>
  );
}
