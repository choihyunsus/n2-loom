// Decode strict UTF-8 SSE and NDJSON while bounding each complete frame independently of pipe chunks.
const MAX_FRAME_BYTES = 2097152;
export class StreamFrames {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private line = '';
  private data: string[] = [];
  private bytes = 0;
  private carriageReturn = false;
  constructor(private readonly mode: 'sse' | 'ndjson') {}
  push(bytes: Uint8Array): string[] {
    const text = this.decoder.decode(bytes, { stream: true });
    const frames: string[] = [];
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      const char = text[index]!;
      if (char !== '\r' && char !== '\n') continue;
      this.append(text.slice(start, index));
      if (char !== '\n' || !this.carriageReturn) this.finishLine(frames);
      this.carriageReturn = char === '\r';
      start = index + 1;
    }
    if (start < text.length) {
      this.carriageReturn = false;
      this.append(text.slice(start));
    }
    return frames;
  }
  finish(): string[] {
    this.decoder.decode();
    const frames: string[] = [];
    if (this.mode === 'ndjson' && this.line.length) this.finishLine(frames);
    if (this.line.length || this.data.length)
      throw new Error('Provider stream ended inside a frame');
    return frames;
  }
  private append(value: string): void {
    if (value.length) this.carriageReturn = false;
    this.bytes += Buffer.byteLength(value);
    if (this.bytes > MAX_FRAME_BYTES) throw new Error('Provider stream frame exceeds 2 MiB');
    this.line += value;
  }
  private finishLine(frames: string[]): void {
    const line = this.line;
    this.line = '';
    if (this.mode === 'ndjson') {
      if (line.trim()) frames.push(line);
      this.bytes = 0;
    } else if (line === '') {
      if (this.data.length) frames.push(this.data.join('\n'));
      this.data = [];
      this.bytes = 0;
    } else if (line.startsWith('data:')) {
      this.data.push(line.slice(line[5] === ' ' ? 6 : 5));
      if (++this.bytes > MAX_FRAME_BYTES) throw new Error('Provider stream frame exceeds 2 MiB');
    }
  }
}
