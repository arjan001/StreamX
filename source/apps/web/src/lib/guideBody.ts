/**
 * A guide download as plain XML bytes, whether or not it arrived compressed.
 *
 * A browser undoes `Content-Encoding: gzip` by itself. A file that is simply
 * NAMED `guide.xml.gz` (served as an opaque download) is not undone, and neither
 * is one whose server forgot the header — so the body's first two bytes decide,
 * not the address or the headers.
 */
export const GZIP_UNSUPPORTED =
  'This device cannot unpack a compressed (.gz) guide. Use a guide link that ends in .xml instead.';

export const isGzip = (b: Uint8Array): boolean => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

export async function guideReader(res: Response): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  if (res.body === null) throw new Error('the guide had no content');
  const reader = res.body.getReader();
  let first = await reader.read();
  /* A first chunk of one byte cannot be told from a gzip header: read on. */
  while (!first.done && first.value.length < 2) {
    const next = await reader.read();
    if (next.done) break;
    const joined = new Uint8Array(first.value.length + next.value.length);
    joined.set(first.value);
    joined.set(next.value, first.value.length);
    first = { done: false, value: joined };
  }
  if (first.done) return new Response(new Uint8Array(0)).body!.getReader();
  const head = first.value;
  const replay = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(head); },
    async pull(c) {
      const next = await reader.read();
      if (next.done) c.close(); else c.enqueue(next.value);
    },
    cancel(why) { return reader.cancel(why); },
  });
  if (!isGzip(head)) return replay.getReader();
  const Decompress = (globalThis as { DecompressionStream?: new (f: 'gzip') => TransformStream<Uint8Array, Uint8Array> })
    .DecompressionStream;
  if (Decompress === undefined) {
    await reader.cancel().catch(() => undefined);
    throw new Error(GZIP_UNSUPPORTED);
  }
  return replay.pipeThrough(new Decompress('gzip')).getReader();
}
