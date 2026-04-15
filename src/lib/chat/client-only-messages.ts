import {
  ERROR_MESSAGE_PREFIX,
  SYSTEM_MESSAGE_PREFIX,
} from "@/lib/opencode-client";
import type { NativeMessage } from "./native-message-types";

export const OPTIMISTIC_MESSAGE_PREFIX = "optimistic-";

function normalizeMessageContent(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}

function getMessageFingerprint(message: Pick<NativeMessage, "role" | "content">): string {
  return `${message.role}:${normalizeMessageContent(message.content)}`;
}

function countFingerprints(messages: NativeMessage[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const message of messages) {
    const fingerprint = getMessageFingerprint(message);
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  }

  return counts;
}

function mergeMessagesByTimestamp(
  incomingMessages: NativeMessage[],
  clientMessages: NativeMessage[],
): NativeMessage[] {
  const mergedMessages = [...incomingMessages];

  for (const clientMessage of clientMessages) {
    const clientTime = new Date(clientMessage.createdAt || 0).getTime();
    let insertIndex = mergedMessages.length;

    for (let i = mergedMessages.length - 1; i >= 0; i--) {
      const incomingMessage = mergedMessages[i];
      if (!incomingMessage) continue;

      const incomingTime = new Date(incomingMessage.createdAt || 0).getTime();
      if (incomingTime <= clientTime) {
        insertIndex = i + 1;
        break;
      }

      if (i === 0 && incomingTime > clientTime) {
        insertIndex = 0;
      }
    }

    mergedMessages.splice(insertIndex, 0, clientMessage);
  }

  return mergedMessages;
}

export function isOptimisticNativeMessage(message: Pick<NativeMessage, "id">): boolean {
  return message.id.startsWith(OPTIMISTIC_MESSAGE_PREFIX);
}

export function isClientOnlyNativeMessage(message: Pick<NativeMessage, "id">): boolean {
  return (
    message.id.startsWith(ERROR_MESSAGE_PREFIX)
    || message.id.startsWith(SYSTEM_MESSAGE_PREFIX)
    || isOptimisticNativeMessage(message)
  );
}

export function mergeNativeMessagesPreservingClientOnly(
  existingMessages: NativeMessage[],
  incomingMessages: NativeMessage[],
): NativeMessage[] {
  const incomingMessageIds = new Set(incomingMessages.map((message) => message.id));
  const existingServerMessages = existingMessages.filter(
    (message) => !isClientOnlyNativeMessage(message),
  );
  const existingClientMessages = existingMessages.filter((message) => {
    return isClientOnlyNativeMessage(message) && !incomingMessageIds.has(message.id);
  });

  if (existingClientMessages.length === 0) {
    return incomingMessages;
  }

  const existingServerFingerprintCounts = countFingerprints(existingServerMessages);
  const incomingFingerprintCounts = countFingerprints(incomingMessages);
  const acknowledgedOptimisticBudgets = new Map<string, number>();

  for (const [fingerprint, incomingCount] of incomingFingerprintCounts) {
    const existingCount = existingServerFingerprintCounts.get(fingerprint) ?? 0;
    if (incomingCount > existingCount) {
      acknowledgedOptimisticBudgets.set(fingerprint, incomingCount - existingCount);
    }
  }

  const clientMessagesToPreserve = existingClientMessages.filter((message) => {
    if (!isOptimisticNativeMessage(message)) {
      return true;
    }

    const fingerprint = getMessageFingerprint(message);
    const remainingBudget = acknowledgedOptimisticBudgets.get(fingerprint) ?? 0;
    if (remainingBudget <= 0) {
      return true;
    }

    acknowledgedOptimisticBudgets.set(fingerprint, remainingBudget - 1);
    return false;
  });

  if (clientMessagesToPreserve.length === 0) {
    return incomingMessages;
  }

  return mergeMessagesByTimestamp(incomingMessages, clientMessagesToPreserve);
}
