// Extracts TP-Link's private G.711 u-law audio PES frames (stream_id 0xC0..0xDF)
// out of raw 188-byte MPEG-TS packets when standard FFmpeg demuxers see tag 0x0091.
export class MulawTsExtractor {
  private buffer = Buffer.alloc(0);
  private audioPids = new Set<number>();
  private remainingByPid = new Map<number, number>();

  feed(chunk: Uint8Array): Buffer {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const extracted: Buffer[] = [];

    while (this.buffer.length >= 188) {
      if (this.buffer[0] !== 0x47) {
        const nextSync = this.buffer.indexOf(0x47);
        if (nextSync === -1) {
          this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 187));
          break;
        }
        this.buffer = this.buffer.subarray(nextSync);
        if (this.buffer.length < 188) break;
      }

      const packet = this.buffer.subarray(0, 188);
      this.buffer = this.buffer.subarray(188);
      const out = this.parsePacket(packet);
      if (out.length > 0) extracted.push(out);
    }

    return extracted.length > 0 ? Buffer.concat(extracted) : Buffer.alloc(0);
  }

  private parsePacket(packet: Buffer): Buffer {
    if (packet[0] !== 0x47) return Buffer.alloc(0);
    const pid = ((packet[1]! & 0x1f) << 8) | packet[2]!;
    const adaptation = (packet[3]! >> 4) & 0x03;
    if ((adaptation & 1) === 0) return Buffer.alloc(0);

    let offset = 4;
    if ((adaptation & 2) !== 0) {
      offset += 1 + packet[4]!;
    }
    if (offset >= 188) return Buffer.alloc(0);

    let payload = packet.subarray(offset);
    if ((packet[1]! & 0x40) !== 0) {
      this.remainingByPid.set(pid, 0);
      if (payload.length < 14 || payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1) {
        return Buffer.alloc(0);
      }
      const streamId = payload[3]!;
      if (streamId < 0xc0 || streamId > 0xdf) return Buffer.alloc(0);
      this.audioPids.add(pid);
      const packetLength = payload.readUInt16BE(4);
      const headerLength = 9 + payload[8]!;
      if (packetLength <= 0 || headerLength > 6 + packetLength) return Buffer.alloc(0);
      this.remainingByPid.set(pid, 6 + packetLength - headerLength);
      payload = payload.subarray(headerLength);
    }

    if (!this.audioPids.has(pid)) return Buffer.alloc(0);
    const remaining = this.remainingByPid.get(pid) ?? 0;
    if (remaining <= 0) return Buffer.alloc(0);

    const take = Math.min(payload.length, remaining);
    this.remainingByPid.set(pid, remaining - take);
    return payload.subarray(0, take);
  }
}
