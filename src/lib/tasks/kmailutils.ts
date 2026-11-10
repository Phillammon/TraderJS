import type { Client } from "kol.js";

const MAX_KMAIL_MESSAGE_LENGTH = 2000;

type KmailOptions = NonNullable<Parameters<Client["kmail"]["send"]>[2]>;

export async function sendKmailMessage(
  client: Client,
  recipientId: number,
  message: string,
  options?: KmailOptions,
): Promise<void> {
  const chunks = splitKmailMessage(message);
  for (const [index, chunk] of chunks.entries()) {
    await client.kmail.send(
      recipientId,
      chunk,
      index === 0 ? options : undefined,
    );
  }
}

function splitKmailMessage(message: string): string[] {
  if (message.length <= MAX_KMAIL_MESSAGE_LENGTH) {
    return [message];
  }

  const chunks: string[] = [];
  let chunk = "";
  let lineStart = 0;
  while (lineStart < message.length) {
    const newline = message.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? message.length : newline + 1;
    const line = message.slice(lineStart, lineEnd);
    if (line.length > MAX_KMAIL_MESSAGE_LENGTH) {
      throw new RangeError(
        `A kmail line is ${line.length} characters, exceeding the ${MAX_KMAIL_MESSAGE_LENGTH}-character limit`,
      );
    }
    if (chunk.length + line.length > MAX_KMAIL_MESSAGE_LENGTH) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += line;
    lineStart = lineEnd;
  }
  if (chunk.length > 0 || chunks.length === 0) {
    chunks.push(chunk);
  }
  return chunks;
}
