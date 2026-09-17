// Minimal ESC/POS command builder for thermal receipt printers (2026-09-13).
// Deliberately hand-rolled instead of pulling in a library: a receipt only
// needs a handful of commands (init, align, bold, line-feed, cut), and every
// commonly-sold Bluetooth thermal printer (58mm/80mm, "generic ESC/POS")
// understands this exact subset. No network/device access happens here — the
// printer is paired with the CASHIER'S device (browser/phone), not this
// server, so the backend's job stops at handing over ready-to-write bytes;
// the frontend just relays `escpos_base64` to the printer via Web Bluetooth
// (or an equivalent native API).
const ESC = 0x1b;
const GS = 0x1d;

const ALIGN = { left: 0, center: 1, right: 2 };

export class EscPosBuilder {
  constructor() {
    this.chunks = [Buffer.from([ESC, 0x40])]; // ESC @ — initialize
  }

  align(mode) {
    this.chunks.push(Buffer.from([ESC, 0x61, ALIGN[mode] ?? 0]));
    return this;
  }

  bold(on) {
    this.chunks.push(Buffer.from([ESC, 0x45, on ? 1 : 0]));
    return this;
  }

  line(text = '') {
    this.chunks.push(Buffer.from(`${text}\n`, 'utf8'));
    return this;
  }

  // Blank line(s) — same as line() with no text, kept as a separate method
  // for readability at call sites.
  feedLines(count = 1) {
    for (let i = 0; i < count; i += 1) this.line('');
    return this;
  }

  // ESC d n — feed n lines before cutting, so the cut doesn't land on the
  // last printed line.
  feedBeforeCut(n = 3) {
    this.chunks.push(Buffer.from([ESC, 0x64, n]));
    return this;
  }

  cut() {
    this.chunks.push(Buffer.from([GS, 0x56, 0x00])); // GS V 0 — full cut
    return this;
  }

  toBuffer() {
    return Buffer.concat(this.chunks);
  }

  toBase64() {
    return this.toBuffer().toString('base64');
  }
}

// --- Plain-text layout helpers, shared between the ESC/POS stream and the
// human-readable `text_lines` fallback (on-screen preview, or a printer the
// frontend drives some other way). `width` is the printer's characters-per-line
// (32 for 58mm paper, 48 for 80mm, at the default font).

export function center(text, width) {
  const str = String(text);
  if (str.length >= width) return str.slice(0, width);
  const pad = width - str.length;
  const left = Math.floor(pad / 2);
  return ' '.repeat(left) + str + ' '.repeat(pad - left);
}

// Left-aligned text on one side, right-aligned on the other, e.g. a label and
// a price on the same line. Truncates `left` if there isn't room, rather than
// overflowing the line width.
export function twoColumns(left, right, width) {
  const leftStr = String(left);
  const rightStr = String(right);
  const space = width - leftStr.length - rightStr.length;
  if (space < 1) {
    const truncated = leftStr.slice(0, Math.max(0, width - rightStr.length - 1));
    return `${truncated} ${rightStr}`.slice(0, width);
  }
  return leftStr + ' '.repeat(space) + rightStr;
}

export function divider(width, char = '-') {
  return char.repeat(width);
}

// Rp 1.234.567 style thousands separator — a manual regex rather than
// `toLocaleString('id-ID')` so formatting doesn't depend on the Node build's
// ICU data being available.
export function formatRupiah(amount) {
  const n = Math.round(Number(amount));
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
