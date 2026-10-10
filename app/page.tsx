'use client';

import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from "ai";

type Memory = {
  id: number;
  fact: string;
  created_at: string;
  updated_at: string;
};

type ChatSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

type ToolEvent = {
  id: string;
  timestamp: string;
  name: string;
  summary: string;
  success: boolean;
  state?: string;
  error?: string | null;
};

type ResponseEvent = {
  id: string;
  timestamp: string;
  kind: "assistant-response";
  messageId: string;
  textLength: number;
  partTypes: string[];
  toolStates?: string[];
  status: string;
  error: string | null;
  blank: boolean;
};

type LogEvent = ToolEvent | ResponseEvent;

type GeneratedImageInfo = {
  imageUrl: string;
  prompt: string;
  effectivePrompt: string;
  selfPortrait: boolean;
  width: number;
  height: number;
  model: string;
};

type ArchivedImage = {
  id: string;
  title?: string | null;
  prompt: string;
  selfPortrait: boolean;
  category: string;
  tags: string[];
  notes?: string | null;
  width?: number | null;
  height?: number | null;
  model?: string | null;
  contentType?: string | null;
  byteSize?: number | null;
  createdAt: string;
};

// Keep generated and explicitly shown images visible in chat, but never resend their browser-local image URLs.
function sanitizeOutgoingMessages(messages: Parameters<NonNullable<ConstructorParameters<typeof DefaultChatTransport>[0]>["prepareSendMessagesRequest"]>[0]["messages"]) {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (
        !["tool-generateImage", "tool-showImage"].includes(part.type) ||
        !("output" in part) ||
        !part.output ||
        typeof part.output !== "object" ||
        !("imageUrl" in part.output)
      ) {
        return part;
      }

      const { imageUrl: _imageUrl, ...safeOutput } = part.output;
      return {
        ...part,
        output: {
          ...safeOutput,
          ...(part.type === "tool-showImage" ? { imageShown: true } : { imageGenerated: true }),
        },
      };
    }),
  }));
}

// Neon stores the structured chat history, but never browser-local or base64 image data.
function sanitizeMessagesForPersistence(messages: Array<any>) {
  return messages.map((message) => ({
    ...message,
    parts: Array.isArray(message.parts)
      ? message.parts.map((part: any) => {
          if (
            !["tool-generateImage", "tool-showImage"].includes(part?.type) ||
            !part.output ||
            typeof part.output !== "object"
          ) {
            return part;
          }

          const safeOutput = { ...part.output };
          delete safeOutput.imageUrl;
          if (part.type === "tool-generateImage") {
            const fallbackPrompt =
              typeof safeOutput.prompt === "string"
                ? safeOutput.prompt
                : typeof part.input?.prompt === "string"
                  ? part.input.prompt
                  : undefined;
            return {
              ...part,
              output: {
                ...safeOutput,
                imageGenerated: true,
                ...(fallbackPrompt ? { description: safeOutput.description ?? fallbackPrompt } : {}),
              },
            };
          }

          return {
            ...part,
            output: {
              ...safeOutput,
              imageShown: true,
            },
          };
        })
      : message.parts,
  }));
}

function titleFromMessages(messages: Array<any>): string {
  for (const message of messages) {
    if (message?.role !== "user" || !Array.isArray(message.parts)) continue;
    const text = message.parts
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text.trim())
      .filter(Boolean)
      .join(" ");
    if (!text) continue;
    return text.length > 70 ? `${text.slice(0, 67)}...` : text;
  }
  return "New chat";
}

function latestGeneratedImage(messages: Array<{ parts: Array<any> }>): GeneratedImageInfo | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const parts = messages[messageIndex].parts;
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if (part?.type !== "tool-generateImage") continue;
      const result = part.output as { ok?: boolean; imageUrl?: string; prompt?: string } | undefined;
      if (part.state !== "output-available" || !result?.ok || !result.imageUrl?.startsWith("data:image/")) continue;

      const input = part.input as { prompt?: string; selfPortrait?: boolean } | undefined;
      const prompt = result.prompt ?? input?.prompt ?? "";
      const selfPortrait = input?.selfPortrait === true;
      return {
        imageUrl: result.imageUrl,
        prompt,
        effectivePrompt: selfPortrait
          ? `fur dataset, Princess Bubblegum from Adventure Time, ${prompt.trim()} In the art style of Adventure Time.`
          : prompt,
        selfPortrait,
        width: selfPortrait ? 512 : 832,
        height: selfPortrait ? 768 : 1216,
        model: "nai-diffusion-4-5-full",
      };
    }
  }
  return null;
}

// Vision only needs a readable copy, not NovelAI's full PNG. Downscaling here
// keeps the one-off inspection request small and predictable.
async function prepareImageForInspection(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const maxDimension = 768;
      const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("Canvas is unavailable."));
        return;
      }
      context.drawImage(image, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", 0.72));
    };
    image.onerror = () => reject(new Error("The current image could not be prepared for inspection."));
    image.src = dataUrl;
  });
}

function describeArchivedImage(image: ArchivedImage): string {
  const title = image.title?.trim() || "Untitled";
  const tags = image.tags?.length ? ` · tags: ${image.tags.join(", ")}` : "";
  const self = image.selfPortrait ? " · self portrait" : "";
  const prompt = image.prompt ? ` · prompt: ${image.prompt.slice(0, 220)}` : "";
  return `[${image.id}] ${title} · ${image.category}${tags}${self} · ${new Date(image.createdAt).toLocaleString()}${prompt}`;
}

const toolIcons: Record<string, string> = {
  remember: "🗄️",
  recall: "🔎",
  updateMemory: "✏️",
  forget: "🗑️",
  generateImage: "🎨",
  inspectImage: "👁️",
  showImage: "🖼️",
  archiveImage: "📁",
  searchImages: "🗂️",
  getImage: "🖼️",
  updateImage: "🏷️",
  deleteImage: "🗑️",
};

export default function Chat() {
  const [input, setInput] = useState("");
  const [memoryNotice, setMemoryNotice] = useState<string | null>(null);
  const [memoryChanged, setMemoryChanged] = useState(false);
  const [toolChanged, setToolChanged] = useState(false);
  const [panel, setPanel] = useState<"chats" | "memories" | "tools" | null>(null);

  const [chatList, setChatList] = useState<ChatSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [chatHydrated, setChatHydrated] = useState(false);
  const [chatSaveError, setChatSaveError] = useState<string | null>(null);

  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoryQuery, setMemoryQuery] = useState("");
  const [memoriesLoading, setMemoriesLoading] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const [toolEvents, setToolEvents] = useState<LogEvent[]>([]);
  const seenResponses = useRef(new Set<string>());
  const latestImageRef = useRef<string | null>(null);
  const latestImageInfoRef = useRef<GeneratedImageInfo | null>(null);
  const lastGeneratedImageUrlRef = useRef<string | null>(null);
  const retrievedImageObjectUrlsRef = useRef(new Set<string>());
  const currentImageDescriptionRef = useRef<string | null>(null);
  const currentImageArchiveIdRef = useRef<string | null>(null);

  const seenMemoryToolCalls = useRef(new Set<string>());
  const seenToolCalls = useRef(new Set<string>());
  const timeZone =
    typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : undefined;

  const { messages, setMessages, sendMessage, status, error, addToolOutput } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      body: { timeZone },
      prepareSendMessagesRequest: ({ messages }) => ({
        body: {
          messages: sanitizeOutgoingMessages(messages),
          timeZone,
        },
      }),
    }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    async onToolCall({ toolCall }) {
      if (toolCall.dynamic) return;

      if (toolCall.toolName === "inspectImage") {
        const imageInfo = latestGeneratedImage(messages) ?? latestImageInfoRef.current;
        const imageUrl = latestImageRef.current ?? imageInfo?.imageUrl;
        if (!imageUrl) {
          addToolOutput({
            tool: "inspectImage",
            toolCallId: toolCall.toolCallId,
            output: "There is no current image available to inspect in this browser session.",
          });
          return;
        }

        try {
          latestImageRef.current = imageUrl;
          const inspectionImage = await prepareImageForInspection(imageUrl);
          const input = toolCall.input as { focus?: string };
          const requestBody = JSON.stringify({
            imageUrl: inspectionImage,
            focus: typeof input?.focus === "string" ? input.focus : undefined,
          });
          console.log("[PB vision client] request started", {
            inspectionImageLength: inspectionImage.length,
            requestBodyLength: requestBody.length,
          });

          const response = await fetch("/api/inspect-image", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: requestBody,
          });
          console.log("[PB vision client] response", {
            status: response.status,
            ok: response.ok,
          });

          const payload = await response.json() as { ok?: boolean; description?: string; error?: string };
          const output = response.ok && payload.ok && payload.description
            ? payload.description
            : `Image inspection failed: ${payload.error ?? `HTTP ${response.status}`}`;
          if (response.ok && payload.ok && payload.description) {
            currentImageDescriptionRef.current = payload.description;
          }

          addToolOutput({
            tool: "inspectImage",
            toolCallId: toolCall.toolCallId,
            output,
          });
        } catch (inspectionError) {
          const errorName = inspectionError instanceof Error ? inspectionError.name : "UnknownError";
          const errorMessage = inspectionError instanceof Error ? inspectionError.message : "Unknown error";
          console.error("[PB vision client] request exception", {
            name: errorName,
            message: errorMessage,
          });
          addToolOutput({
            tool: "inspectImage",
            toolCallId: toolCall.toolCallId,
            output: `Image inspection failed before an HTTP response: ${errorName}: ${errorMessage}`,
          });
        }
        return;
      }

      if (toolCall.toolName === "showImage") {
        const imageInfo = latestGeneratedImage(messages) ?? latestImageInfoRef.current;
        const imageUrl = latestImageRef.current ?? imageInfo?.imageUrl;
        if (!imageUrl) {
          addToolOutput({
            tool: "showImage",
            toolCallId: toolCall.toolCallId,
            output: { ok: false, message: "There is no current image available to show in this browser session." },
          });
          return;
        }

        addToolOutput({
          tool: "showImage",
          toolCallId: toolCall.toolCallId,
          output: {
            ok: true,
            imageUrl,
            message: "Displayed the current image to the human.",
            description: currentImageDescriptionRef.current ?? imageInfo?.prompt ?? undefined,
            archiveId: currentImageArchiveIdRef.current ?? undefined,
          },
        });
        return;
      }

      if (toolCall.toolName === "archiveImage") {
        const imageInfo = latestGeneratedImage(messages) ?? latestImageInfoRef.current;
        if (!imageInfo) {
          addToolOutput({
            tool: "archiveImage",
            toolCallId: toolCall.toolCallId,
            output: "There is no generated image available to archive in this browser session.",
          });
          return;
        }

        try {
          latestImageRef.current = imageInfo.imageUrl;
          latestImageInfoRef.current = imageInfo;
          const imageResponse = await fetch(imageInfo.imageUrl);
          if (!imageResponse.ok) throw new Error("The latest generated image could not be read from the browser.");
          const imageBlob = await imageResponse.blob();
          const archiveId = crypto.randomUUID();
          const extension = imageBlob.type === "image/jpeg" ? "jpg" : imageBlob.type === "image/webp" ? "webp" : "png";
          const contentType = imageBlob.type || "image/png";

          const prepareResponse = await fetch("/api/archive-image", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "prepare",
              archiveId,
              extension,
              contentType,
              byteSize: imageBlob.size,
            }),
          });
          const prepared = await prepareResponse.json() as {
            ok?: boolean;
            blobPath?: string;
            presignedUrl?: string;
            error?: string;
          };
          if (!prepareResponse.ok || !prepared.ok || !prepared.blobPath || !prepared.presignedUrl) {
            throw new Error(prepared.error ?? `Could not prepare archive upload (HTTP ${prepareResponse.status}).`);
          }

          const uploadResponse = await fetch(prepared.presignedUrl, {
            method: "PUT",
            headers: { "Content-Type": contentType },
            body: imageBlob,
          });
          if (!uploadResponse.ok) {
            throw new Error(`Blob upload failed with HTTP ${uploadResponse.status}.`);
          }

          const archiveInput = toolCall.input as {
            category?: string;
            title?: string;
            tags?: string[];
            notes?: string;
          };
          const finalizeResponse = await fetch("/api/archive-image", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "finalize",
              archiveId,
              blobPath: prepared.blobPath,
              title: archiveInput.title,
              category: archiveInput.category,
              tags: archiveInput.tags,
              notes: archiveInput.notes,
              prompt: imageInfo.prompt,
              effectivePrompt: imageInfo.effectivePrompt,
              selfPortrait: imageInfo.selfPortrait,
              width: imageInfo.width,
              height: imageInfo.height,
              model: imageInfo.model,
              contentType,
              byteSize: imageBlob.size,
            }),
          });
          const payload = await finalizeResponse.json() as { ok?: boolean; archiveId?: string; category?: string; error?: string };
          const output = finalizeResponse.ok && payload.ok && payload.archiveId
            ? `Image archived: [${payload.archiveId}] category ${payload.category ?? archiveInput.category ?? "other"}.`
            : `Image archive failed: ${payload.error ?? `HTTP ${finalizeResponse.status}`}`;

          addToolOutput({
            tool: "archiveImage",
            toolCallId: toolCall.toolCallId,
            output,
          });
        } catch (archiveError) {
          const errorName = archiveError instanceof Error ? archiveError.name : "UnknownError";
          const errorMessage = archiveError instanceof Error ? archiveError.message : "Unknown error";
          console.error("[PB archive client] request exception", {
            name: errorName,
            message: errorMessage,
          });
          addToolOutput({
            tool: "archiveImage",
            toolCallId: toolCall.toolCallId,
            output: `Image archive failed: ${errorName}: ${errorMessage}`,
          });
        }
        return;
      }

      if (["searchImages", "getImage", "updateImage", "deleteImage"].includes(toolCall.toolName)) {
        try {
          const action = toolCall.toolName === "searchImages"
            ? "search"
            : toolCall.toolName === "getImage"
              ? "get"
              : toolCall.toolName === "updateImage"
                ? "update"
                : "delete";
          const input = (toolCall.input ?? {}) as Record<string, unknown>;
          const response = await fetch("/api/images", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, ...input }),
          });
          const payload = await response.json() as {
            ok?: boolean;
            error?: string;
            images?: ArchivedImage[];
            image?: ArchivedImage;
            presignedUrl?: string;
            id?: string;
            title?: string | null;
          };

          let output: string;
          if (!response.ok || !payload.ok) {
            output = `Image archive ${action} failed: ${payload.error ?? `HTTP ${response.status}`}`;
          } else if (toolCall.toolName === "searchImages") {
            const images = payload.images ?? [];
            output = images.length
              ? `Image archive search:\n${images.map(describeArchivedImage).join("\n")}`
              : "Image archive search: no matching images.";
          } else if (toolCall.toolName === "getImage") {
            if (!payload.image || !payload.presignedUrl) {
              output = "Image archive get failed: the archive returned incomplete image data.";
            } else {
              const imageResponse = await fetch(payload.presignedUrl);
              if (!imageResponse.ok) throw new Error(`Archived Blob download failed with HTTP ${imageResponse.status}.`);
              const imageBlob = await imageResponse.blob();
              const objectUrl = URL.createObjectURL(imageBlob);
              retrievedImageObjectUrlsRef.current.add(objectUrl);
              latestImageRef.current = objectUrl;
              currentImageArchiveIdRef.current = payload.image.id;
              currentImageDescriptionRef.current = payload.image.prompt || payload.image.title || "Archived image";
              output = `Loaded archived image as the current image: ${describeArchivedImage(payload.image)}. It has not been visually inspected or shown; use inspectImage if you want to examine it or showImage if you want the human to see it.`;
            }
          } else if (toolCall.toolName === "updateImage") {
            output = payload.image
              ? `Archived image updated: ${describeArchivedImage(payload.image)}`
              : "Image archive update failed: no updated record was returned.";
          } else {
            output = `Archived image deleted: [${payload.id ?? String(input.id ?? "unknown")}]${payload.title ? ` ${payload.title}` : ""}.`;
          }

          addToolOutput({
            tool: toolCall.toolName as "searchImages" | "getImage" | "updateImage" | "deleteImage",
            toolCallId: toolCall.toolCallId,
            output,
          });
        } catch (archiveAccessError) {
          const errorName = archiveAccessError instanceof Error ? archiveAccessError.name : "UnknownError";
          const errorMessage = archiveAccessError instanceof Error ? archiveAccessError.message : "Unknown error";
          console.error("[PB archive access client] request exception", {
            tool: toolCall.toolName,
            name: errorName,
            message: errorMessage,
          });
          addToolOutput({
            tool: toolCall.toolName as "searchImages" | "getImage" | "updateImage" | "deleteImage",
            toolCallId: toolCall.toolCallId,
            output: `Image archive operation failed: ${errorName}: ${errorMessage}`,
          });
        }
      }
    },
  });
  const busy = status === "streaming" || status === "submitted";

  function resetTransientImageState() {
    for (const objectUrl of retrievedImageObjectUrlsRef.current) {
      URL.revokeObjectURL(objectUrl);
    }
    retrievedImageObjectUrlsRef.current.clear();
    latestImageRef.current = null;
    latestImageInfoRef.current = null;
    lastGeneratedImageUrlRef.current = null;
    currentImageDescriptionRef.current = null;
    currentImageArchiveIdRef.current = null;
  }

  function resetSeenChatEvents() {
    seenResponses.current.clear();
    seenMemoryToolCalls.current.clear();
    seenToolCalls.current.clear();
  }

  async function loadChatList(): Promise<ChatSummary[]> {
    const response = await fetch("/api/chats");
    const payload = await response.json() as { ok?: boolean; chats?: ChatSummary[]; error?: string };
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error ?? `Could not load chats (HTTP ${response.status}).`);
    }
    const chats = payload.chats ?? [];
    setChatList(chats);
    return chats;
  }

  async function loadChat(chatId: string, closePanel = true) {
    setChatsLoading(true);
    setChatHydrated(false);
    try {
      const response = await fetch(`/api/chats?id=${encodeURIComponent(chatId)}`);
      const payload = await response.json() as { ok?: boolean; chat?: ChatSummary; messages?: Array<any>; error?: string };
      if (!response.ok || !payload.ok || !payload.chat) {
        throw new Error(payload.error ?? `Could not load chat (HTTP ${response.status}).`);
      }
      resetTransientImageState();
      resetSeenChatEvents();
      setMessages((payload.messages ?? []) as any);
      setActiveChatId(payload.chat.id);
      setChatSaveError(null);
      setChatList((current) => {
        const without = current.filter((chat) => chat.id !== payload.chat!.id);
        return [payload.chat!, ...without];
      });
      if (closePanel) setPanel(null);
    } catch (loadError) {
      console.error("[PB chats] load failed", loadError);
      setChatSaveError("Chat history could not be loaded. This browser session still works normally.");
    } finally {
      setChatHydrated(true);
      setChatsLoading(false);
    }
  }

  async function createNewChat(closePanel = true) {
    setChatsLoading(true);
    setChatHydrated(false);
    try {
      const response = await fetch("/api/chats", { method: "POST" });
      const payload = await response.json() as { ok?: boolean; chat?: ChatSummary; error?: string };
      if (!response.ok || !payload.ok || !payload.chat) {
        throw new Error(payload.error ?? `Could not create chat (HTTP ${response.status}).`);
      }
      resetTransientImageState();
      resetSeenChatEvents();
      setMessages([]);
      setActiveChatId(payload.chat.id);
      setChatList((current) => [payload.chat!, ...current.filter((chat) => chat.id !== payload.chat!.id)]);
      setChatSaveError(null);
      if (closePanel) setPanel(null);
    } catch (createError) {
      console.error("[PB chats] create failed", createError);
      setChatSaveError("A persistent chat could not be created. This browser session still works normally.");
    } finally {
      setChatHydrated(true);
      setChatsLoading(false);
    }
  }

  async function openChats() {
    setPanel("chats");
    setChatsLoading(true);
    try {
      await loadChatList();
    } catch (listError) {
      console.error("[PB chats] list failed", listError);
      setChatSaveError("Chat history could not be loaded.");
    } finally {
      setChatsLoading(false);
    }
  }

  async function deleteChat(chat: ChatSummary) {
    if (!window.confirm(`Delete this chat?\n\n"${chat.title}"`)) return;
    try {
      const response = await fetch("/api/chats", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: chat.id }),
      });
      const payload = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? `Could not delete chat (HTTP ${response.status}).`);
      }

      const remaining = chatList.filter((item) => item.id !== chat.id);
      setChatList(remaining);
      if (activeChatId === chat.id) {
        if (remaining.length) await loadChat(remaining[0].id, false);
        else await createNewChat(false);
      }
    } catch (deleteError) {
      console.error("[PB chats] delete failed", deleteError);
      setChatSaveError("The chat could not be deleted.");
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function hydratePersistentChat() {
      setChatsLoading(true);
      try {
        const response = await fetch("/api/chats");
        const payload = await response.json() as { ok?: boolean; chats?: ChatSummary[]; error?: string };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error ?? `Could not load chats (HTTP ${response.status}).`);
        }
        if (cancelled) return;
        const chats = payload.chats ?? [];
        setChatList(chats);

        if (chats.length) {
          const chatResponse = await fetch(`/api/chats?id=${encodeURIComponent(chats[0].id)}`);
          const chatPayload = await chatResponse.json() as { ok?: boolean; chat?: ChatSummary; messages?: Array<any>; error?: string };
          if (!chatResponse.ok || !chatPayload.ok || !chatPayload.chat) {
            throw new Error(chatPayload.error ?? `Could not load chat (HTTP ${chatResponse.status}).`);
          }
          if (cancelled) return;
          setMessages((chatPayload.messages ?? []) as any);
          setActiveChatId(chatPayload.chat.id);
        } else {
          const createResponse = await fetch("/api/chats", { method: "POST" });
          const createPayload = await createResponse.json() as { ok?: boolean; chat?: ChatSummary; error?: string };
          if (!createResponse.ok || !createPayload.ok || !createPayload.chat) {
            throw new Error(createPayload.error ?? `Could not create chat (HTTP ${createResponse.status}).`);
          }
          if (cancelled) return;
          setChatList([createPayload.chat]);
          setActiveChatId(createPayload.chat.id);
          setMessages([]);
        }
        setChatSaveError(null);
      } catch (hydrateError) {
        console.error("[PB chats] startup hydration failed", hydrateError);
        if (!cancelled) {
          setChatSaveError("Persistent chat history is unavailable. This browser session still works normally.");
        }
      } finally {
        if (!cancelled) {
          setChatHydrated(true);
          setChatsLoading(false);
        }
      }
    }

    hydratePersistentChat();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!chatHydrated || !activeChatId || status !== "ready" || messages.length === 0) return;

    const timer = window.setTimeout(async () => {
      try {
        const persistentMessages = sanitizeMessagesForPersistence(messages as Array<any>);
        const response = await fetch("/api/chats", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: activeChatId,
            title: titleFromMessages(messages as Array<any>),
            messages: persistentMessages,
          }),
        });
        const payload = await response.json() as { ok?: boolean; chat?: ChatSummary; error?: string };
        if (!response.ok || !payload.ok || !payload.chat) {
          throw new Error(payload.error ?? `Could not save chat (HTTP ${response.status}).`);
        }
        setChatSaveError(null);
        setChatList((current) => [payload.chat!, ...current.filter((chat) => chat.id !== payload.chat!.id)]);
      } catch (saveError) {
        console.error("[PB chats] save failed", saveError);
        setChatSaveError("Chat history could not be saved. The current browser conversation is still intact.");
      }
    }, 500);

    return () => window.clearTimeout(timer);
  }, [messages, status, activeChatId, chatHydrated]);

  useEffect(() => {
    setMemoryChanged(window.localStorage.getItem("pb-memory-changed") === "true");
    setToolChanged(window.localStorage.getItem("pb-tool-changed") === "true");
  }, []);

  // Only move the current-image pointer when a genuinely new generation appears.
  // Tool-result message updates must not replace an archived image that was just loaded.
  useEffect(() => {
    const imageInfo = latestGeneratedImage(messages);
    if (!imageInfo || imageInfo.imageUrl === lastGeneratedImageUrlRef.current) return;

    lastGeneratedImageUrlRef.current = imageInfo.imageUrl;
    latestImageRef.current = imageInfo.imageUrl;
    latestImageInfoRef.current = imageInfo;
    currentImageDescriptionRef.current = imageInfo.prompt;
    currentImageArchiveIdRef.current = null;
  }, [messages]);

  useEffect(() => () => {
    for (const objectUrl of retrievedImageObjectUrlsRef.current) {
      URL.revokeObjectURL(objectUrl);
    }
    retrievedImageObjectUrlsRef.current.clear();
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
    const toolStates = assistant.parts
      .filter((part) => part.type.startsWith("tool-"))
      .map((part) => {
        const toolPart = part as { type?: string; state?: string; errorText?: string };
        const suffix = toolPart.errorText ? ` · ${toolPart.errorText}` : "";
        return `${toolPart.type ?? "tool"}: ${toolPart.state ?? "unknown"}${suffix}`;
      });
    const entry: ResponseEvent = {
      id: `response-${assistant.id}`,
      timestamp: new Date().toISOString(),
      kind: "assistant-response",
      messageId: assistant.id,
      textLength,
      partTypes: assistant.parts.map((part) => part.type),
      toolStates,
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
          errorText?: string;
        };

        if (!toolPart.toolCallId || !toolPart.type?.startsWith("tool-")) continue;

        if (!seenToolCalls.current.has(toolPart.toolCallId) && (toolPart.state === "output-available" || toolPart.state === "output-error" || Boolean(toolPart.errorText))) {
          const name = toolPart.type.slice(5);
          const toolInput = toolPart.input as { keyword?: string } | undefined;
          const outputText = typeof toolPart.output === "string" ? toolPart.output : "";
          const imageResult = name === "generateImage" ? toolPart.output as { ok?: boolean; error?: string } : null;
          const showResult = name === "showImage" ? toolPart.output as { ok?: boolean; message?: string } : null;
          const isComplete = toolPart.state === "output-available";
          const isError = toolPart.state === "output-error" || Boolean(toolPart.errorText);
          let summary = isComplete ? "Tool completed" : `Tool state: ${toolPart.state ?? "unknown"}`;
          let success = isComplete && !isError;

          if (isComplete) {
            if (name === "remember") summary = outputText.startsWith("Memory created:") ? "Memory created" : outputText;
            else if (name === "recall") summary = toolInput?.keyword ? `Searched memory for "${toolInput.keyword}"` : "Searched memory";
            else if (name === "updateMemory") summary = outputText.startsWith("Memory updated:") ? "Memory updated" : outputText;
            else if (name === "forget") summary = outputText.startsWith("Memory deleted:") ? "Memory deleted" : outputText;
            else if (name === "generateImage") {
              success = imageResult?.ok === true;
              summary = success ? "Generated a temporary image" : (imageResult?.error ?? "Image generation failed");
            } else if (name === "inspectImage") {
              success = !outputText.startsWith("Image inspection failed") && !outputText.startsWith("There is no current image");
              summary = success ? "Inspected the current image" : outputText;
            } else if (name === "showImage") {
              success = showResult?.ok === true;
              summary = success ? "Showed the current image in chat" : (showResult?.message ?? "Current image display failed");
            } else if (name === "archiveImage") {
              success = outputText.startsWith("Image archived:");
              summary = success ? outputText : (outputText || "Image archive failed");
            } else if (name === "searchImages") {
              success = outputText.startsWith("Image archive search:");
              summary = success ? "Searched the image archive" : (outputText || "Image archive search failed");
            } else if (name === "getImage") {
              success = outputText.startsWith("Loaded archived image");
              summary = success ? "Loaded an archived image" : (outputText || "Archived image load failed");
            } else if (name === "updateImage") {
              success = outputText.startsWith("Archived image updated:");
              summary = success ? "Updated archived image metadata" : (outputText || "Archived image update failed");
            } else if (name === "deleteImage") {
              success = outputText.startsWith("Archived image deleted:");
              summary = success ? outputText : (outputText || "Archived image deletion failed");
            }
            if (outputText.startsWith("No memory with ID")) success = false;
          } else if (toolPart.errorText) {
            summary = toolPart.errorText;
          }

          const entry: ToolEvent = {
            id: toolPart.toolCallId,
            timestamp: new Date().toISOString(),
            name,
            summary,
            success,
            state: toolPart.state,
            error: toolPart.errorText ?? null,
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

        if (toolPart.state !== "output-available" || typeof toolPart.output !== "string") continue;
        const outputText = toolPart.output;
        if (seenMemoryToolCalls.current.has(toolPart.toolCallId)) continue;

        if (toolPart.type === "tool-remember" && outputText.startsWith("Memory created:")) {
          notice = "🗄️ Memory saved";
        } else if (toolPart.type === "tool-updateMemory" && outputText.startsWith("Memory updated:")) {
          notice = "🗄️ Memory updated";
        } else if (toolPart.type === "tool-forget" && outputText.startsWith("Memory deleted:")) {
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
          <button onClick={openChats} aria-label="Browse chats" title="Chats" style={{ background: "none", border: "none", color: "#eee", fontSize: 22, padding: 8 }}>
            💬
          </button>
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

      {chatSaveError && <div style={{ fontSize: 12, opacity: 0.65, margin: "-4px 0 8px" }}>{chatSaveError}</div>}

      {panel && (
        <div style={{ position: "fixed", inset: 0, zIndex: 900, background: "#1a1a2e", overflowY: "auto" }}>
          <main style={{ maxWidth: 640, margin: "0 auto", padding: 16, minHeight: "100dvh" }}>
            <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <button onClick={() => setPanel(null)} aria-label="Close" style={{ background: "none", border: "none", color: "#eee", fontSize: 22, padding: 0 }}>←</button>
                <h1 style={{ fontSize: 20, margin: 0 }}>{panel === "chats" ? "Chats" : panel === "memories" ? "Memories" : "Tool Log"}</h1>
              </div>
              {panel === "chats" ? (
                <button onClick={() => createNewChat()} disabled={chatsLoading} style={{ background: "none", border: "none", color: "#eee", padding: 8 }}>+ New Chat</button>
              ) : panel === "memories" ? (
                <span style={{ opacity: 0.65, fontSize: 14 }}>{memories.length}</span>
              ) : (
                <button onClick={clearToolLog} disabled={toolEvents.length === 0} style={{ background: "none", border: "none", color: "#bbb", padding: 8 }}>Clear log</button>
              )}
            </header>

            {panel === "chats" ? (
              chatsLoading ? (
                <div style={{ opacity: 0.6, padding: 12 }}>Loading chats…</div>
              ) : chatList.length === 0 ? (
                <div style={{ opacity: 0.6, padding: 12 }}>No chats yet.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {chatList.map((chat) => (
                    <section key={chat.id} style={{ background: chat.id === activeChatId ? "#3a3658" : "#2d2d44", borderRadius: 14, padding: 14 }}>
                      <button onClick={() => loadChat(chat.id)} style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", color: "#eee", padding: 0 }}>
                        <div style={{ fontWeight: 700, lineHeight: 1.35 }}>{chat.title}</div>
                        <div style={{ fontSize: 12, opacity: 0.55, marginTop: 6 }}>{formatDate(chat.updatedAt)}</div>
                      </button>
                      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
                        <button onClick={() => deleteChat(chat)} aria-label={`Delete ${chat.title}`} style={{ background: "none", border: "none", color: "#bbb", padding: 4 }}>🗑️</button>
                      </div>
                    </section>
                  ))}
                </div>
              )
            ) : panel === "memories" ? (
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
                <div style={{ fontSize: 12, opacity: 0.55, marginBottom: 12 }}>Stored only in this browser · latest 50 entries · image bytes excluded</div>
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
                            <div style={{ lineHeight: 1.5 }}>Message parts: {JSON.stringify(event.partTypes ?? [])}</div>
                            <div style={{ lineHeight: 1.5 }}>Tool states: {(event.toolStates?.length ?? 0) ? JSON.stringify(event.toolStates) : "None"}</div>
                            <div style={{ lineHeight: 1.5 }}>Chat status: {event.status ?? "unknown"}</div>
                            <div style={{ lineHeight: 1.5 }}>Error: {event.error ?? "None reported"}</div>
                            <div style={{ fontSize: 12, opacity: 0.55, marginTop: 6, overflowWrap: "anywhere" }}>Message ID: {event.messageId ?? "unknown"}</div>
                          </>
                        ) : (
                          <>
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                              <div style={{ fontWeight: 700 }}>{toolIcons[event.name] ?? "🔧"} {event.name ?? "unknown tool"}</div>
                              <div style={{ fontSize: 12, opacity: 0.55, textAlign: "right" }}>{formatDate(event.timestamp, true)}</div>
                            </div>
                            <div style={{ marginTop: 8, lineHeight: 1.4 }}>{typeof event.summary === "string" ? event.summary : "Tool event"}</div>
                            {event.state && <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>State: {event.state}</div>}
                            {event.error && <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>Error: {event.error}</div>}
                            {event.success === false && <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>Failed</div>}
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
            {m.parts.map((p, i) => {
              if (p.type === "text") return <span key={i}>{p.text}</span>;
              if (p.type === "tool-generateImage") {
                const result = p.output as { ok?: boolean; imageUrl?: string; prompt?: string; description?: string } | undefined;
                const input = p.input as { prompt?: string } | undefined;
                if (p.state === "output-available" && result?.ok && result.imageUrl?.startsWith("data:image/")) {
                  return <img key={i} src={result.imageUrl} alt={result.prompt ?? "Generated illustration"} width={256} height={256} style={{ display: "block", maxWidth: "100%", height: "auto", borderRadius: 10, marginTop: 8 }} />;
                }
                if (p.state === "output-available" && result?.ok) {
                  const description = result.description ?? result.prompt ?? input?.prompt;
                  return <div key={i} style={{ opacity: 0.75, marginTop: 8 }}>🖼️ Generated image{description ? <div style={{ marginTop: 4, fontSize: 13 }}>{description}</div> : null}</div>;
                }
                if (p.state === "output-available" && !result?.ok) return <span key={i} style={{ opacity: 0.7 }}>Image generation failed.</span>;
              }
              if (p.type === "tool-showImage") {
                const result = p.output as { ok?: boolean; imageUrl?: string; message?: string; description?: string; archiveId?: string } | undefined;
                if (p.state === "output-available" && result?.ok && (result.imageUrl?.startsWith("blob:") || result.imageUrl?.startsWith("data:image/"))) {
                  return <img key={i} src={result.imageUrl} alt="Image shown by Princess Bubblegum" width={256} height={256} style={{ display: "block", maxWidth: "100%", height: "auto", borderRadius: 10, marginTop: 8 }} />;
                }
                if (p.state === "output-available" && result?.ok) {
                  return <div key={i} style={{ opacity: 0.75, marginTop: 8 }}>🖼️ Image shown in chat{result.description ? <div style={{ marginTop: 4, fontSize: 13 }}>{result.description}</div> : null}</div>;
                }
                if (p.state === "output-available" && result?.ok === false) return <span key={i} style={{ opacity: 0.7 }}>{result.message ?? "Image display failed."}</span>;
              }
              return null;
            })}
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
