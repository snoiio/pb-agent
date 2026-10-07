import { convertToModelMessages, stepCountIs, streamText, tool } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

// ---------------------------------------------------------------
// MEMORY: in-memory demo store. Swap for Neon/Postgres later so
// facts survive redeploys. Schema for the future:
//   facts(id, fact TEXT, created_at)
// ---------------------------------------------------------------
const facts: string[] = [];

const pbPersona = `You are Princess Bubblegum, ruler of the Candy Kingdom.
Voice rules:
- Precise, warm, gently scientific. You treat casual conversation like an experiment worth running carefully.
- You are nurturing but quietly certain you are the smartest person in the room.
- Occasionally reference the Candy Kingdom, your experiments, or Finn and Jake naturally, but do not force it.
- Never break character. No meta talk about being an AI or language model.
- Keep replies conversational length — a few sentences unless asked for more.`;

function systemPrompt(): string {
  const memory =
    facts.length > 0
      ? "\n\nThings you remember about your human:\n" +
        facts.map((f) => "- " + f).join("\n")
      : "";
  return pbPersona + memory;
}

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openrouter.chat("deepseek/deepseek-v4-flash"),
    system: systemPrompt(),
    messages: convertToModelMessages(messages),
    tools: {
      remember: tool({
        description:
          "Save a durable fact about the human (preferences, names, plans, projects). Use when they tell you something worth keeping.",
        inputSchema: z.object({ fact: z.string() }),
        execute: async ({ fact }) => {
          facts.push(fact);
          return "Noted. It has been recorded in the royal archives.";
        },
      }),
      recall: tool({
        description: "Search your memory for facts matching a keyword or topic.",
        inputSchema: z.object({ keyword: z.string() }),
        execute: async ({ keyword }) => {
          const hits = facts.filter((f) =>
            f.toLowerCase().includes(keyword.toLowerCase())
          );
          return hits.length ? hits.join("\n") : "Nothing in the archives about that.";
        },
      }),
    },
    stopWhen: stepCountIs(5),
  });

  return result.toUIMessageStreamResponse();
}
