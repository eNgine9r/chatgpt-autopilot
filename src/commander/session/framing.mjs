import { StringDecoder } from 'node:string_decoder';

export const COMMANDER_MAX_FRAME_BYTES = 64 * 1024;
export const COMMANDER_MAX_FRAMES_PER_PUSH = 64;

export class JsonLineDecoder {
  constructor({ maxFrameBytes = COMMANDER_MAX_FRAME_BYTES } = {}) {
    this.maxFrameBytes = maxFrameBytes;
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) throw new Error('invalid_frame_chunk');
    if (chunk.byteLength > this.maxFrameBytes * 4) throw new Error('frame_batch_too_large');
    this.buffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer) > this.maxFrameBytes && !this.buffer.includes('\n')) {
      throw new Error('frame_too_large');
    }
    const messages = [];
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) break;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > this.maxFrameBytes) throw new Error('frame_too_large');
      let value;
      try { value = JSON.parse(line); } catch { throw new Error('invalid_frame_json'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_frame_message');
      messages.push(value);
      if (messages.length > COMMANDER_MAX_FRAMES_PER_PUSH) throw new Error('too_many_frames');
    }
    return messages;
  }

  end() {
    this.buffer += this.decoder.end();
    if (this.buffer.trim()) throw new Error('incomplete_frame');
  }
}

export function encodeJsonLine(value, { maxFrameBytes = COMMANDER_MAX_FRAME_BYTES } = {}) {
  const encoded = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(encoded) > maxFrameBytes) throw new Error('frame_too_large');
  return encoded;
}
