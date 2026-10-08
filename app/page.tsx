'use client';

import { useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";

export default function Chat() {
  const [input, setInput] = useState("");
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

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: 16, display: "flex", flexDirection: "column", height: "100dvh" }}>
      <h1 style={{ fontSize: 20 }}>🍬 Princess Bubblegum</h1>
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
