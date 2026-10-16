const messageLimit = 2000;

type CodeBlock = { text: string; opening: string; body: string; closing: string };
type Block = { text: string } | CodeBlock;

export function splitMessages(text: string): string[] {
  const messages: string[] = [];
  let current = "";
  for (const block of blocks(text)) {
    const parts =
      block.text.length <= messageLimit
        ? [block.text]
        : "opening" in block
          ? splitCode(block)
          : splitText(block.text, messageLimit);
    for (const part of parts) {
      if (current.length + part.length > messageLimit) {
        messages.push(current);
        current = "";
      }
      current += part;
    }
  }
  if (current) messages.push(current);
  return messages;
}

export function windowMessage(lines: string[]): string {
  let current = "";
  for (const text of lines.toReversed()) {
    if (!text || text.length > messageLimit) continue;
    const next = current ? `${text}\n${current}` : text;
    if (next.length > messageLimit) break;
    current = next;
  }
  return current;
}

function blocks(text: string): Block[] {
  const result: Block[] = [];
  let plain = "";
  let code: { opening: string; body: string; marker: string } | undefined;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (code) {
      const closing = /^ {0,3}(`{3,}|~{3,})[\t ]*(?:\r?\n)?$/.exec(line)?.[1];
      if (closing && closing[0] === code.marker[0] && closing.length >= code.marker.length) {
        result.push({
          text: code.opening + code.body + line,
          opening: code.opening,
          body: code.body,
          closing: line,
        });
        code = undefined;
      } else {
        code.body += line;
      }
      continue;
    }
    const fence = /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n)?$/.exec(line)?.[1];
    if (fence) {
      if (plain) result.push({ text: plain });
      plain = "";
      code = { opening: line, body: "", marker: fence };
      continue;
    }
    if (/^ {0,3}#{1,6}\s/.test(line) && plain) {
      result.push({ text: plain });
      plain = "";
    }
    plain += line;
    if (!line.trim()) {
      result.push({ text: plain });
      plain = "";
    }
  }
  if (code)
    result.push({
      text: code.opening + code.body,
      opening: code.opening,
      body: code.body,
      closing: code.marker,
    });
  if (plain) result.push({ text: plain });
  return result;
}

function splitCode({ text, opening, body, closing }: CodeBlock): string[] {
  const capacity = messageLimit - opening.length - closing.length - 2;
  if (capacity < 2) return splitText(text, messageLimit);
  const parts = splitText(body, capacity, true);
  return parts.map(
    (part, index) =>
      opening +
      part +
      (part.endsWith("\n") ? "" : "\n") +
      closing +
      (index < parts.length - 1 && !closing.endsWith("\n") ? "\n" : ""),
  );
}

function splitText(text: string, limit: number, code = false): string[] {
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const boundaries = code
      ? [/\n(?=@@(?: |$))/g, /\n/g, /[\t ]+/g]
      : [/\n[\t ]*\n/g, /\n/g, /[.!?]["'”’)]*\s+/g, /\s+/g];
    let end = 0;
    for (const boundary of boundaries) {
      for (const match of window.matchAll(boundary)) {
        const candidate = match.index + match[0].length;
        if (candidate <= limit) end = candidate;
      }
      if (end) break;
    }
    end ||= limit;
    const previous = remaining.charCodeAt(end - 1);
    const next = remaining.charCodeAt(end);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
    parts.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) parts.push(remaining);
  return parts;
}
