// build/shims/chacha20.ts — ChaCha20 流密码（标准实现，96-bit nonce，counter 从 0）
// 替代 PS 依赖的 ts-chacha20，接口兼容：new Chacha20(key, nonce).encrypt(data)

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function qr(s: Uint32Array, a: number, b: number, c: number, d: number) {
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 7);
}

function readLE32(b: Uint8Array, i: number): number {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
}
function writeLE32(b: Uint8Array, i: number, v: number) {
  b[i] = v & 0xff; b[i + 1] = (v >>> 8) & 0xff; b[i + 2] = (v >>> 16) & 0xff; b[i + 3] = (v >>> 24) & 0xff;
}

const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]; // "expand 32-byte k"

export class Chacha20 {
  private key: Uint8Array;
  private nonce: Uint8Array;
  private counter: number;

  constructor(key: Uint8Array, nonce: Uint8Array) {
    this.key = key;
    this.nonce = nonce;
    this.counter = 0;
  }

  private block(counter: number): Uint8Array {
    const state = new Uint32Array(16);
    state[0] = SIGMA[0]; state[1] = SIGMA[1]; state[2] = SIGMA[2]; state[3] = SIGMA[3];
    for (let i = 0; i < 8; i++) state[4 + i] = readLE32(this.key, i * 4);
    state[12] = counter;
    for (let i = 0; i < 3; i++) state[13 + i] = readLE32(this.nonce, i * 4);

    const working = new Uint32Array(state);
    for (let i = 0; i < 10; i++) {
      qr(working, 0, 4, 8, 12); qr(working, 1, 5, 9, 13); qr(working, 2, 6, 10, 14); qr(working, 3, 7, 11, 15);
      qr(working, 0, 5, 10, 15); qr(working, 1, 6, 11, 12); qr(working, 2, 7, 8, 13); qr(working, 3, 4, 9, 14);
    }

    const out = new Uint8Array(64);
    for (let i = 0; i < 16; i++) writeLE32(out, i * 4, (state[i] + working[i]) >>> 0);
    return out;
  }

  encrypt(data: Uint8Array): Uint8Array {
    const out = new Uint8Array(data.length);
    let counter = this.counter;
    for (let i = 0; i < data.length; i += 64) {
      const ks = this.block(counter++);
      for (let j = 0; j < 64 && i + j < data.length; j++) out[i + j] = data[i + j] ^ ks[j];
    }
    return out;
  }
}
