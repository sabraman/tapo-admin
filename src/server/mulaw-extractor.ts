// Extracts TP-Link's private G.711 u-law audio PES frames (stream_id 0xC0..0xDF)
// out of raw 188-byte MPEG-TS packets when standard FFmpeg demuxers see tag 0x0091.

function decodePesPts(payload: Buffer): number | null {
  if (payload.length < 14) return null;
  if ((payload[7]! & 0x80) === 0 || payload[8]! < 5) return null;
  const p0 = payload[9]!;
  const p1 = payload[10]!;
  const p2 = payload[11]!;
  const p3 = payload[12]!;
  const p4 = payload[13]!;
  // Use arithmetic multiplication so 33-bit PTS values never overflow 32-bit signed shifts.
  return (
    ((p0 & 0x0e) / 2) * 0x40000000 +
    p1 * 0x400000 +
    ((p2 & 0xfe) / 2) * 0x8000 +
    p3 * 0x80 +
    ((p4 & 0xfe) / 2)
  );
}

export class MulawTsExtractor {
  private buffer = Buffer.alloc(0);
  private audioPids = new Set<number>();
  private remainingByPid = new Map<number, number>();
  private firstPts: number | null = null;
  private lastPts: number | null = null;
  private totalBytes = 0;
  private bytesAtLastPts = 0;

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
      if (out.length > 0) {
        this.totalBytes += out.length;
        extracted.push(out);
      }
    }

    return extracted.length > 0 ? Buffer.concat(extracted) : Buffer.alloc(0);
  }

  getEstimatedSampleRate(): 8000 | 16000 {
    if (this.firstPts === null || this.lastPts === null || this.lastPts === this.firstPts) {
      return 16000;
    }
    const ptsDiff =
      this.lastPts >= this.firstPts
        ? this.lastPts - this.firstPts
        : this.lastPts + 0x200000000 - this.firstPts;
    const deltaSec = ptsDiff / 90000;
    if (deltaSec < 0.15 || this.bytesAtLastPts < 800) {
      return 16000;
    }
    const rate = this.bytesAtLastPts / deltaSec;
    return rate >= 5000 && rate <= 11500 ? 8000 : 16000;
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
      const pts = decodePesPts(payload);
      if (pts !== null) {
        if (this.firstPts === null) {
          this.firstPts = pts;
          this.lastPts = pts;
          this.bytesAtLastPts = 0;
        } else {
          this.lastPts = pts;
          this.bytesAtLastPts = this.totalBytes;
        }
      }
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
