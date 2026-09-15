import type { DelegationMessage } from "./delegation-types.js";

const HANDOVER_NOTE =
  "[System Note: The following is prior conversation history from this thread before switching models. Please continue the conversation seamlessly using this context.]";

function parseHandoverText(text: string, sourceId: string): DelegationMessage[] | null {
  const match = text.match(
    /^\[System Note: The following is prior conversation history from this thread before switching models\. Please continue the conversation seamlessly using this context\.\]\n\n--- Prior Conversation History ---\n([\s\S]*?)\n--- End Prior Conversation History ---\n\n([\s\S]*)$/,
  );
  if (!match?.[1] || match[2] === undefined) return null;

  const messages: DelegationMessage[] = [];
  const entryPattern = /\[(User|Assistant)\]:\n([\s\S]*?)(?=\n\n\[(?:User|Assistant)\]:\n|$)/g;
  let matchEntry: RegExpExecArray | null;
  let index = 0;
  while ((matchEntry = entryPattern.exec(match[1])) !== null) {
    const messageText = matchEntry[2]?.trim();
    if (!messageText) continue;
    messages.push({
      id: `handover-${sourceId}-prior-${index++}`,
      turnId: `handover-${sourceId}`,
      role: matchEntry[1] === "User" ? "user" : "agent",
      text: messageText,
    });
  }
  const currentText = match[2].trim();
  if (currentText) {
    messages.push({
      id: `handover-${sourceId}-current`,
      turnId: `handover-${sourceId}`,
      role: "user",
      text: currentText,
    });
  }
  return messages.length > 0 ? messages : null;
}

/** Expand Host-generated handover envelopes after a Native Session is restored. */
export function expandHandoverMessages(
  messages: readonly DelegationMessage[],
): DelegationMessage[] {
  return messages.flatMap((message) => {
    if (!message.text.startsWith(HANDOVER_NOTE)) return [message];
    return parseHandoverText(message.text, message.id) ?? [message];
  });
}

/**
 * Default budget for 1M-token context window models (e.g. Gemini 1M, Claude extended).
 * Reserving ~20% of context window for current turn prompt and output generation leaves ~800k tokens
 * for prior context history, safely represented as ~2,400,000 characters.
 */
export const DEFAULT_MAX_HANDOVER_CHARS = 2_400_000;

export function formatHandoverContext(
  messages: readonly DelegationMessage[],
  nextUserPrompt: string,
  maxHistoryChars: number = DEFAULT_MAX_HANDOVER_CHARS,
): string {
  if (messages.length === 0) {
    return nextUserPrompt;
  }

  const anchor = messages[0];
  const remaining = messages.slice(1);

  const selected: DelegationMessage[] = [];
  let currentChars = anchor ? anchor.text.trim().length + 50 : 0;

  // Preserve the latest messages backwards; if the 1M budget is exceeded, early history is omitted.
  for (let i = remaining.length - 1; i >= 0; i--) {
    const msg = remaining[i];
    if (!msg) continue;
    const cost = msg.text.trim().length + 50;
    if (currentChars + cost > maxHistoryChars) {
      break;
    }
    selected.unshift(msg);
    currentChars += cost;
  }

  const finalMessages = anchor ? [anchor, ...selected] : selected;

  const formattedHistory = finalMessages
    .map((msg) => {
      const sender = msg.role === "user" ? "User" : "Assistant";
      return `[${sender}]:\n${msg.text.trim()}`;
    })
    .join("\n\n");

  return `[System Note: The following is prior conversation history from this thread before switching models. Please continue the conversation seamlessly using this context.]\n\n--- Prior Conversation History ---\n${formattedHistory}\n--- End Prior Conversation History ---\n\n${nextUserPrompt}`;
}
