const TS_PACKET_SIZE = 188;
const MAX_GOP_BYTES = 2 * 1024 * 1024;

function getPayloadOffset(pkt: Buffer): number | null {
  const afc = (pkt[3]! >> 4) & 0x03;
  if (afc === 1) return 4;
  if (afc === 3) {
    const adaptLen = pkt[4]!;
    const offset = 5 + adaptLen;
    return offset < TS_PACKET_SIZE ? offset : null;
  }
  return null;
}

function hasRandomAccessIndicator(pkt: Buffer): boolean {
  const afc = (pkt[3]! >> 4) & 0x03;
  if (afc !== 2 && afc !== 3) return false;
  const adaptLen = pkt[4]!;
  return adaptLen >= 1 && (pkt[5]! & 0x40) !== 0;
}

function hasH264IdrOrSpsStart(payload: Buffer): boolean {
  // Check PES header if starting with 00 00 01 Ex
  let scanFrom = 0;
  if (
    payload.length >= 9 &&
    payload[0] === 0x00 &&
    payload[1] === 0x00 &&
    payload[2] === 0x01 &&
    (payload[3]! & 0xf0) === 0xe0
  ) {
    const pesHeaderDataLen = payload[8]!;
    scanFrom = Math.min(payload.length, 9 + pesHeaderDataLen);
  }

  for (let i = scanFrom; i + 4 < payload.length; i++) {
    if (payload[i] === 0x00 && payload[i + 1] === 0x00) {
      let nalOffset = -1;
      if (payload[i + 2] === 0x01) {
        nalOffset = i + 3;
      } else if (i + 4 < payload.length && payload[i + 2] === 0x00 && payload[i + 3] === 0x01) {
        nalOffset = i + 4;
      }
      if (nalOffset !== -1 && nalOffset < payload.length) {
        const nalType = payload[nalOffset]! & 0x1f;
        if (nalType === 5 || nalType === 7) return true;
      }
    }
  }
  return false;
}

function parsePmtPidFromPat(pkt: Buffer): number | null {
  const pusi = (pkt[1]! & 0x40) !== 0;
  if (!pusi) return null;
  const offset = getPayloadOffset(pkt);
  if (offset === null || offset + 12 >= TS_PACKET_SIZE) return null;
  const pointer = pkt[offset]!;
  const sec = offset + 1 + pointer;
  if (sec + 12 >= TS_PACKET_SIZE || pkt[sec] !== 0x00) return null;
  const secLen = ((pkt[sec + 1]! & 0x0f) << 8) | pkt[sec + 2]!;
  const progEnd = Math.min(TS_PACKET_SIZE, sec + 3 + secLen - 4);
  for (let p = sec + 8; p + 4 <= progEnd; p += 4) {
    const progNum = pkt.readUInt16BE(p);
    if (progNum !== 0) {
      return ((pkt[p + 2]! & 0x1f) << 8) | pkt[p + 3]!;
    }
  }
  return null;
}

function parseH264PidFromPmt(pkt: Buffer): number | null {
  const pusi = (pkt[1]! & 0x40) !== 0;
  if (!pusi) return null;
  const offset = getPayloadOffset(pkt);
  if (offset === null || offset + 14 >= TS_PACKET_SIZE) return null;
  const pointer = pkt[offset]!;
  const sec = offset + 1 + pointer;
  if (sec + 12 >= TS_PACKET_SIZE || pkt[sec] !== 0x02) return null;
  const secLen = ((pkt[sec + 1]! & 0x0f) << 8) | pkt[sec + 2]!;
  const progInfoLen = ((pkt[sec + 10]! & 0x0f) << 8) | pkt[sec + 11]!;
  let pos = sec + 12 + progInfoLen;
  const secEnd = Math.min(TS_PACKET_SIZE, sec + 3 + secLen - 4);
  while (pos + 5 <= secEnd) {
    const streamType = pkt[pos]!;
    const esPid = ((pkt[pos + 1]! & 0x1f) << 8) | pkt[pos + 2]!;
    const esInfoLen = ((pkt[pos + 3]! & 0x0f) << 8) | pkt[pos + 4]!;
    if (streamType === 0x1b || streamType === 0x24) {
      return esPid;
    }
    pos += 5 + esInfoLen;
  }
  return null;
}

/**
 * Maintains the latest PAT, PMT, and current keyframe GOP from a live MPEG-TS stream
 * so new WebSocket / WebCodecs subscribers immediately receive a decodable entry point.
 */
export class TsGopBuffer {
  private remainder: Buffer = Buffer.alloc(0);
  private patPacket: Buffer | null = null;
  private pmtPacket: Buffer | null = null;
  private pmtPid: number | null = null;
  private videoPid: number | null = null;
  private gopPackets: Buffer[] = [];
  private gopBytes = 0;

  feed(chunk: Uint8Array): Buffer {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const buf: Buffer = this.remainder.length > 0 ? Buffer.concat([this.remainder, incoming]) : incoming;
    const aligned: Buffer[] = [];

    let offset = 0;
    let runStart = 0;
    while (offset + TS_PACKET_SIZE <= buf.length) {
      if (buf[offset] !== 0x47) {
        if (offset > runStart) {
          aligned.push(buf.subarray(runStart, offset));
        }
        const nextSync = buf.indexOf(0x47, offset + 1);
        if (nextSync === -1) {
          offset = buf.length;
          runStart = offset;
          break;
        }
        offset = nextSync;
        runStart = nextSync;
        continue;
      }

      const pkt = buf.subarray(offset, offset + TS_PACKET_SIZE);
      offset += TS_PACKET_SIZE;
      this.processPacket(pkt);
    }

    if (offset > runStart) {
      aligned.push(buf.subarray(runStart, offset));
    }

    this.remainder = offset < buf.length ? Buffer.from(buf.subarray(offset)) : Buffer.alloc(0);
    if (aligned.length === 0) return Buffer.alloc(0);
    if (aligned.length === 1) return Buffer.from(aligned[0]!);
    return Buffer.concat(aligned);
  }

  private processPacket(pkt: Buffer): void {
    const pid = ((pkt[1]! & 0x1f) << 8) | pkt[2]!;
    const pusi = (pkt[1]! & 0x40) !== 0;

    if (pid === 0x0000) {
      this.patPacket = Buffer.from(pkt);
      const parsed = parsePmtPidFromPat(pkt);
      if (parsed !== null) this.pmtPid = parsed;
      return;
    }

    if (this.pmtPid !== null && pid === this.pmtPid) {
      this.pmtPacket = Buffer.from(pkt);
      const parsedVideo = parseH264PidFromPmt(pkt);
      if (parsedVideo !== null) this.videoPid = parsedVideo;
      return;
    }

    const payloadOffset = getPayloadOffset(pkt);
    if (this.videoPid === null && pusi && payloadOffset !== null) {
      const p = pkt.subarray(payloadOffset);
      if (p.length >= 4 && p[0] === 0x00 && p[1] === 0x00 && p[2] === 0x01 && (p[3]! & 0xf0) === 0xe0) {
        this.videoPid = pid;
      }
    }

    if (this.videoPid === null || pid !== this.videoPid) return;

    let isKeyframeStart = hasRandomAccessIndicator(pkt);
    if (!isKeyframeStart && pusi && payloadOffset !== null) {
      isKeyframeStart = hasH264IdrOrSpsStart(pkt.subarray(payloadOffset));
    }

    if (isKeyframeStart) {
      this.gopPackets = [Buffer.from(pkt)];
      this.gopBytes = TS_PACKET_SIZE;
      return;
    }

    if (this.gopPackets.length > 0 && this.gopBytes + TS_PACKET_SIZE <= MAX_GOP_BYTES) {
      this.gopPackets.push(Buffer.from(pkt));
      this.gopBytes += TS_PACKET_SIZE;
    }
  }

  getBootstrapChunk(): Buffer | null {
    if (!this.patPacket || !this.pmtPacket || this.gopPackets.length === 0) {
      return null;
    }
    return Buffer.concat([this.patPacket, this.pmtPacket, ...this.gopPackets]);
  }

  reset(): void {
    this.remainder = Buffer.alloc(0);
    this.patPacket = null;
    this.pmtPacket = null;
    this.pmtPid = null;
    this.videoPid = null;
    this.gopPackets = [];
    this.gopBytes = 0;
  }
}
