import test from "node:test";
import assert from "node:assert/strict";
import {
  PacketStreamDecoder,
  ScanAssembler,
  calculateChecksum,
  decodePacket,
} from "../public/js/protocol.js";

// 构造公开协议格式的无强度三角雷达数据包，测试不依赖真实串口即可覆盖解析器。
function makePacket({ ct = 0, fsaDeg = 10, lsaDeg = 20, samples = [4000, 8000, 0] } = {}) {
  const fsa = ((Math.round(fsaDeg * 64) << 1) | 1) & 0xffff;
  const lsa = ((Math.round(lsaDeg * 64) << 1) | 1) & 0xffff;
  const checksum = calculateChecksum(ct, samples.length, fsa, lsa, samples);
  const bytes = [
    0xaa, 0x55, ct, samples.length,
    fsa & 0xff, (fsa >> 8) & 0xff,
    lsa & 0xff, (lsa >> 8) & 0xff,
    checksum & 0xff, (checksum >> 8) & 0xff,
  ];
  for (const sample of samples) bytes.push(sample & 0xff, (sample >> 8) & 0xff);
  return Uint8Array.from(bytes);
}

// 将一个字节数组切成不规则块，模拟 Web Serial 的任意分包行为。
function feedInChunks(decoder, bytes) {
  const packets = [];
  for (let index = 0; index < bytes.length;) {
    const size = [1, 2, 7][index % 3];
    packets.push(...decoder.push(bytes.slice(index, index + size)));
    index += size;
  }
  return packets;
}

test("解析官方零位包并忽略占位点", () => {
  const official = Uint8Array.from("AA 55 01 01 53 AE 53 AE AB 54 00 00".split(" ").map((value) => parseInt(value, 16)));
  const packet = decodePacket(official);
  assert.equal(packet.valid, true);
  assert.equal(packet.isStartPacket, true);
  assert.equal(packet.scanHz, 0);
  assert.equal(packet.points.length, 0);
  assert.equal(packet.startAngle, 348.640625);
});

test("解析距离、角度插值和三角角度修正", () => {
  const packet = decodePacket(makePacket());
  assert.equal(packet.valid, true);
  assert.deepEqual(packet.points.map((point) => point.distanceMm), [1000, 2000, 0]);
  assert.equal(packet.points[2].valid, false);
  assert.ok(Math.abs(packet.points[0].angleDeg - 3.237813978) < 1e-6);
  assert.ok(Math.abs(packet.points[1].angleDeg - 7.622756) < 1e-6);
  assert.equal(packet.points[0].sampleIndex, 0);
  assert.equal(packet.points[0].packetIndex, -1);
  assert.equal(packet.points[0].rawAngleDeg, 10);
  assert.ok(Number.isFinite(packet.points[0].angleCorrectionDeg));
  assert.equal(packet.points[2].invalidReason, "zero-distance");
});

test("支持噪声、跨块和截断包恢复", () => {
  const decoder = new PacketStreamDecoder();
  const packetBytes = makePacket();
  const noise = Uint8Array.from([0x00, 0x12, 0xaa, 0x54, 0xff]);
  const combined = new Uint8Array(noise.length + packetBytes.length);
  combined.set(noise);
  combined.set(packetBytes, noise.length);
  const packets = feedInChunks(decoder, combined);
  assert.equal(packets.length, 1);
  assert.equal(decoder.getStats().droppedBytes, noise.length);

  const secondDecoder = new PacketStreamDecoder();
  assert.equal(secondDecoder.push(packetBytes.slice(0, -1)).length, 0);
  assert.equal(secondDecoder.push(packetBytes.slice(-1)).length, 1);
});

test("坏校验包不会阻止后续合法包解析", () => {
  const decoder = new PacketStreamDecoder();
  const broken = makePacket();
  broken[8] ^= 0x80;
  const good = makePacket({ fsaDeg: 30, lsaDeg: 40 });
  const bytes = new Uint8Array(broken.length + good.length);
  bytes.set(broken);
  bytes.set(good, broken.length);
  const packets = decoder.push(bytes);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].startAngle, 30);
  assert.equal(decoder.getStats().checksumErrors, 1);
});

test("拒绝超过 X3 常用上限的 LSN 并允许后续重同步", () => {
  const decoder = new PacketStreamDecoder({ maxLsn: 40 });
  const tooMany = makePacket({ samples: Array.from({ length: 41 }, () => 1000) });
  const good = makePacket({ fsaDeg: 50, lsaDeg: 60 });
  const bytes = new Uint8Array(tooMany.length + good.length);
  bytes.set(tooMany);
  bytes.set(good, tooMany.length);
  const packets = decoder.push(bytes);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].startAngle, 50);
});

test("非法角度标志不会让伪造的大 LSN 包阻塞后续数据", () => {
  const decoder = new PacketStreamDecoder({ maxLsn: 40 });
  const fakeHeader = Uint8Array.from([0xaa, 0x55, 0x00, 0x28, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const good = makePacket({ fsaDeg: 70, lsaDeg: 80 });
  const bytes = new Uint8Array(fakeHeader.length + good.length);
  bytes.set(fakeHeader);
  bytes.set(good, fakeHeader.length);
  const packets = decoder.push(bytes);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].startAngle, 70);
  assert.ok(decoder.getStats().malformedPackets >= 1);
});

test("首个起始包只建立同步，跨圈边界才输出完整扫描", () => {
  const assembler = new ScanAssembler();
  const normal = decodePacket(makePacket({ samples: [1000, 1200, 0] }));
  const start = decodePacket(makePacket({ ct: 0xa3, samples: [0] }));
  assert.equal(assembler.push(normal, 1), null);
  assert.equal(assembler.push(start, 2), null);
  assert.equal(assembler.push(normal, 3), null);
  const frame = assembler.push(start, 4);
  assert.ok(frame);
  assert.equal(frame.points.length, 3);
  assert.equal(frame.points.filter((point) => point.valid).length, 2);
  assert.equal(frame.packetCount, 1);
  assert.equal(frame.scanHz, 8.1);
  assert.equal(frame.points[0].packetIndex, 0);
  assert.equal(frame.points[1].sampleIndex, 1);
  assert.ok(frame.measuredScanHz > 0);
  assert.ok(assembler.getProgress().progress01 >= 0);
});

test("角度跨越 360° 时仍能生成有效包", () => {
  const packet = decodePacket(makePacket({ fsaDeg: 350, lsaDeg: 10, samples: [400, 400, 400] }));
  assert.equal(packet.valid, true);
  assert.equal(packet.points.length, 3);
  assert.ok(packet.points[1].angleDeg > 0 && packet.points[1].angleDeg < 10);
});

test("高频输入且丢失起始包时不会让单圈缓存无限增长", () => {
  const assembler = new ScanAssembler({ maxScanPoints: 8 });
  const normal = decodePacket(makePacket({ samples: [1000, 1000, 1000] }));
  const start = decodePacket(makePacket({ ct: 0xa3, samples: [0] }));
  assembler.push(start, 1);
  assembler.push(normal, 2);
  assembler.push(normal, 3);
  assembler.push(normal, 4);
  assert.equal(assembler.points.length, 0);
  assert.equal(assembler.started, false);
  assert.equal(assembler.push(normal, 5), null);
  assert.equal(assembler.points.length, 0);
  assert.equal(assembler.push(start, 6), null);
  assert.equal(assembler.started, true);
});
