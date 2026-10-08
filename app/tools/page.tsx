'use client';

import Link from "next/link";
import { useEffect, useState } from "react";

type ToolEvent = {
  id: string;
  timestamp: string;
  name: string;
  summary: string;
  success: boolean;
};

const icons: Record<string, string> = {
  remember: "🗄️",
  recall: "🔎",
  updateMemory: "✏️",
  forget: "🗑️",
};

export default function ToolLog() {
  const [events, setEvents] = useState<ToolEvent[]>([]);

  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem("pb-tool-log") ?? "[]");
      setEvents(Array.isArray(stored) ? stored : []);
    } catch {
      setEvents([]);
    }
    window.localStorage.removeItem("pb-tool-changed");
  }, []);

  function clearLog() {
    if (!window.confirm("Clear the local tool log?")) return;
    window.localStorage.removeItem("pb-tool-log");
    setEvents([]);
  }

  function formatTime(value: string) {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(new Date(value));
  }

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: 16, minHeight: "100dvh" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Link href="/" style={{ color: "#eee", textDecoration: "none", fontSize: 22 }}>←</Link>
          <h1 style={{ fontSize: 20, margin: 0 }}>Tool Log</h1>
        </div>
        <button
          onClick={clearLog}
          disabled={events.length === 0}
          style={{ background: "none", border: "none", color: "#bbb", padding: 8 }}
        >
          Clear log
        </button>
      </header>

      <div style={{ fontSize: 12, opacity: 0.55, marginBottom: 12 }}>
        Stored only in this browser · latest 50 calls
      </div>

      {events.length === 0 ? (
        <div style={{ opacity: 0.6, padding: 12 }}>No tool calls logged yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {events.map((event) => (
            <section key={event.id} style={{ background: "#2d2d44", borderRadius: 14, padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                <div style={{ fontWeight: 700 }}>
                  {icons[event.name] ?? "🔧"} {event.name}
                </div>
                <div style={{ fontSize: 12, opacity: 0.55, textAlign: "right" }}>
                  {formatTime(event.timestamp)}
                </div>
              </div>
              <div style={{ marginTop: 8, lineHeight: 1.4 }}>{event.summary}</div>
              {!event.success && (
                <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>Failed</div>
              )}
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
