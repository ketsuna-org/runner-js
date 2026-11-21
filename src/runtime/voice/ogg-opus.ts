import { Transform, type TransformCallback } from 'node:stream';

/**
 * Muxeur Ogg/Opus minimal (RFC 3533 et RFC 7845) : reçoit des paquets Opus bruts (sans les décoder) et
 * écrit un fichier .ogg lisible partout. Le silence n'est pas émis par Discord : il est donc absent du
 * fichier (la piste est compacte, sans alignement sur l'horloge de la session).
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

export function oggCrc(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) & 0xff) ^ byte]!) >>> 0;
  return crc >>> 0;
}

/** Durée d'un paquet Opus en échantillons à 48 kHz, d'après l'octet TOC (RFC 6716 §3.1). */
export function opusPacketSamples(packet: Uint8Array): number {
  if (packet.length === 0) return 0;
  const toc = packet[0]!;
  const config = toc >> 3;
  let frameSamples: number;
  if (config >= 16) frameSamples = [120, 240, 480, 960][config & 3]!; // CELT : 2,5 / 5 / 10 / 20 ms
  else if (config >= 12) frameSamples = config & 1 ? 960 : 480; // hybride : 10 / 20 ms
  else frameSamples = [480, 960, 1920, 2880][config & 3]!; // SILK : 10 / 20 / 40 / 60 ms
  const code = toc & 3;
  const frames = code === 0 ? 1 : code === 3 ? (packet[1] ?? 1) & 0x3f : 2;
  return frameSamples * frames;
}

function page(serial: number, sequence: number, flags: number, granule: bigint, packets: Uint8Array[]): Buffer {
  const lacing: number[] = [];
  for (const p of packets) {
    let remaining = p.length;
    while (remaining >= 255) {
      lacing.push(255);
      remaining -= 255;
    }
    lacing.push(remaining);
  }
  const bodyLength = packets.reduce((n, p) => n + p.length, 0);
  const out = Buffer.alloc(27 + lacing.length + bodyLength);
  out.write('OggS', 0, 'latin1');
  out[4] = 0;
  out[5] = flags;
  out.writeBigUInt64LE(granule < 0n ? 0xffffffffffffffffn : granule, 6);
  out.writeUInt32LE(serial, 14);
  out.writeUInt32LE(sequence, 18);
  out.writeUInt32LE(0, 22);
  out[26] = lacing.length;
  lacing.forEach((value, i) => (out[27 + i] = value));
  let offset = 27 + lacing.length;
  for (const p of packets) {
    out.set(p, offset);
    offset += p.length;
  }
  out.writeUInt32LE(oggCrc(out), 22);
  return out;
}

export class OggOpusMuxer extends Transform {
  private readonly serial = (Math.random() * 0xffffffff) >>> 0;
  private sequence = 0;
  private granule = 0n;
  private pending: Uint8Array[] = [];
  private pendingSamples = 0n;
  private started = false;

  constructor(private readonly channels = 2, private readonly maxPacketsPerPage = 10) {
    super({ readableObjectMode: false, writableObjectMode: true });
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    const head = Buffer.alloc(19);
    head.write('OpusHead', 0, 'latin1');
    head[8] = 1;
    head[9] = this.channels;
    head.writeUInt16LE(312, 10); // pré-roll standard
    head.writeUInt32LE(48000, 12);
    head.writeInt16LE(0, 16);
    head[18] = 0;
    const vendor = Buffer.from('bot-creator', 'latin1');
    const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
    tags.write('OpusTags', 0, 'latin1');
    tags.writeUInt32LE(vendor.length, 8);
    vendor.copy(tags, 12);
    tags.writeUInt32LE(0, 12 + vendor.length);
    this.push(page(this.serial, this.sequence++, 0x02, 0n, [head]));
    this.push(page(this.serial, this.sequence++, 0x00, 0n, [tags]));
  }

  private flushPage(last: boolean): void {
    if (this.pending.length === 0 && !last) return;
    this.granule += this.pendingSamples;
    this.push(page(this.serial, this.sequence++, last ? 0x04 : 0x00, this.granule, this.pending));
    this.pending = [];
    this.pendingSamples = 0n;
  }

  override _transform(chunk: Uint8Array, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.start();
    this.pending.push(chunk);
    this.pendingSamples += BigInt(opusPacketSamples(chunk));
    if (this.pending.length >= this.maxPacketsPerPage) this.flushPage(false);
    callback();
  }

  override _flush(callback: TransformCallback): void {
    this.start();
    this.flushPage(true);
    callback();
  }
}
