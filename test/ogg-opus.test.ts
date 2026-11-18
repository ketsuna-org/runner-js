import { describe, expect, it } from 'bun:test';
import OpusScript from 'opusscript';

import { OggOpusMuxer, oggCrc, opusPacketSamples } from '../src/runtime/voice/ogg-opus.js';

async function mux(packets: Uint8Array[]): Promise<Buffer> {
  const muxer = new OggOpusMuxer(2);
  const chunks: Buffer[] = [];
  muxer.on('data', (c: Buffer) => chunks.push(c));
  const ended = new Promise<void>((resolve) => muxer.on('end', () => resolve()));
  for (const p of packets) muxer.write(p);
  muxer.end();
  await ended;
  return Buffer.concat(chunks);
}

function pages(file: Buffer): { flags: number; granule: bigint; seq: number; ok: boolean }[] {
  const out = [];
  let offset = 0;
  while (offset < file.length) {
    expect(file.toString('latin1', offset, offset + 4)).toBe('OggS');
    const segs = file[offset + 26]!;
    let body = 0;
    for (let i = 0; i < segs; i++) body += file[offset + 27 + i]!;
    const size = 27 + segs + body;
    const page = Buffer.from(file.subarray(offset, offset + size));
    const stored = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    out.push({ flags: file[offset + 5]!, granule: file.readBigUInt64LE(offset + 6), seq: file.readUInt32LE(offset + 18), ok: oggCrc(page) === stored });
    offset += size;
  }
  return out;
}

describe('OggOpusMuxer', () => {
  it('calcule la durée d un paquet depuis le TOC', () => {
    expect(opusPacketSamples(Uint8Array.from([0x78]))).toBe(960); // CELT 20 ms, 1 trame
    expect(opusPacketSamples(Uint8Array.from([0xfc, 0x00]))).toBe(960);
    expect(opusPacketSamples(new Uint8Array())).toBe(0);
  });

  it('écrit un fichier Ogg valide : en-têtes, CRC, granule, fin de flux', async () => {
    const encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
    const frame = Buffer.alloc(960 * 2 * 2);
    const packets = Array.from({ length: 25 }, () => new Uint8Array(encoder.encode(frame, 960)));
    const file = await mux(packets);
    expect(file.toString('latin1', 28, 36)).toBe('OpusHead');
    const all = pages(file);
    expect(all.every((p) => p.ok)).toBe(true);
    expect(all[0]!.flags & 0x02).toBe(0x02); // début de flux
    expect(all.at(-1)!.flags & 0x04).toBe(0x04); // fin de flux
    expect(all.at(-1)!.granule).toBe(BigInt(25 * 960));
    expect(all.map((p) => p.seq)).toEqual(all.map((_, i) => i));
  });
});
