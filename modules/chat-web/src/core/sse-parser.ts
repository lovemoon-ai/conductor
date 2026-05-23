/**
 * Minimal Server-Sent Events parser.
 *
 * Implements the subset of the WHATWG EventSource spec that ChatGPT,
 * DeepSeek and similar streaming endpoints actually use:
 *   - Events separated by a blank line.
 *   - `data:` fields concatenated with "\n" within an event.
 *   - `event:` and `id:` fields read into the corresponding properties.
 *   - Lines starting with ":" are comments and discarded.
 *   - A single leading space after the field colon is stripped.
 *
 * Doesn't handle retry hints (`retry:`) or BOM stripping — neither matters
 * for our consumers.
 */
export interface SSEEvent {
  event?: string;
  data: string;
  id?: string;
}

export function parseSSE(text: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  // Normalise newlines so the blank-line split is robust against \r\n vs \n.
  const normalised = text.replace(/\r\n?/g, "\n");
  for (const block of normalised.split(/\n\n+/)) {
    const ev = parseBlock(block);
    if (ev) events.push(ev);
  }
  return events;
}

function parseBlock(block: string): SSEEvent | null {
  if (!block.trim()) return null;
  const ev: SSEEvent = { data: "" };
  const dataLines: string[] = [];
  for (const rawLine of block.split("\n")) {
    if (!rawLine) continue;
    if (rawLine.startsWith(":")) continue; // comment
    const colon = rawLine.indexOf(":");
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    let value = colon === -1 ? "" : rawLine.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data":
        dataLines.push(value);
        break;
      case "event":
        ev.event = value;
        break;
      case "id":
        ev.id = value;
        break;
      default:
        // ignore unknown fields (retry, etc.)
        break;
    }
  }
  if (dataLines.length === 0) {
    // An event with no data line is meaningless to us; drop it.
    return null;
  }
  ev.data = dataLines.join("\n");
  return ev;
}
