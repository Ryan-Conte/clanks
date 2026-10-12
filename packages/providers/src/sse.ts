/** The `data` payloads of a server-sent event stream, one per event. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const piece of body as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(piece, { stream: true });
    let end: number;
    while ((end = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '');
      const data = dataOf(event);
      if (data !== null) yield data;
    }
  }
  const data = dataOf(buffer + decoder.decode());
  if (data !== null) yield data;
}

function dataOf(event: string): string | null {
  const lines = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''));
  return lines.length > 0 ? lines.join('\n') : null;
}
