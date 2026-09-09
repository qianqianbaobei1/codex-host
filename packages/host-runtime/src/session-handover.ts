import type { DelegationMessage } from "./delegation-types.js";

export function formatHandoverContext(
  messages: readonly DelegationMessage[],
  nextUserPrompt: string,
): string {
  if (messages.length === 0) {
    return nextUserPrompt;
  }
  const formattedHistory = messages
    .map((msg) => {
      const sender = msg.role === "user" ? "User" : "Assistant";
      return `[${sender}]:\n${msg.text.trim()}`;
    })
    .join("\n\n");

  return `[System Note: The following is prior conversation history from this thread before switching models. Please continue the conversation seamlessly using this context.]\n\n--- Prior Conversation History ---\n${formattedHistory}\n--- End Prior Conversation History ---\n\n${nextUserPrompt}`;
}
