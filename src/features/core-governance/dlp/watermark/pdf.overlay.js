'use strict';

const PDFDocument = require('pdfkit');

let measurer = null;
/** Largura do texto em Helvetica (métricas AFM que o pdfkit já traz), em pontos, para o tamanho 1. */
function unitWidth(text) {
  if (!measurer) measurer = new PDFDocument().font('Helvetica').fontSize(1);
  return measurer.widthOfString(text);
}

/** Texto como bytes WinAnsi (o que a fonte padrão do PDF entende) já escapado para string literal; caractere fora do Latin-1 vira "?". */
function pdfString(text) {
  const bytes = [];
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    const byte = code < 256 ? code : 63;
    if (byte === 40 || byte === 41 || byte === 92) bytes.push(92);
    bytes.push(byte < 32 ? 63 : byte);
  }
  return Buffer.from(bytes);
}

/** Caixa [x0 y0 x1 y1] normalizada; sem caixa válida, Carta (612 x 792). */
function boxOf(value) {
  const box = Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === 'number') ? value : [0, 0, 612, 792];
  return { x0: Math.min(box[0], box[2]), y0: Math.min(box[1], box[3]), x1: Math.max(box[0], box[2]), y1: Math.max(box[1], box[3]) };
}

const num = (value) => Number(value.toFixed(3));

/**
 * Fluxo de conteúdo da marca de uma página: texto cinza claro e translúcido na diagonal, no centro, mais uma linha pequena no rodapé. Começa com `Q` (fecha o `q` que abre o
 * conteúdo original) e guarda o estado gráfico, então qualquer desequilíbrio do original não desloca a marca. Usa os recursos /NayWmF (fonte) e /NayWmG (transparência).
 */
function overlayStream(text, mediaBox) {
  const { x0, y0, x1, y1 } = boxOf(mediaBox);
  const width = x1 - x0; const height = y1 - y0;
  const angle = Math.atan2(height, width) * 0.75;
  const diagonal = Math.hypot(width, height);
  const size = Math.max(6, Math.min(42, (diagonal * 0.7) / Math.max(unitWidth(text), 1)));
  const half = (unitWidth(text) * size) / 2;
  const cos = Math.cos(angle); const sin = Math.sin(angle);
  const cx = x0 + width / 2; const cy = y0 + height / 2;
  const body = Buffer.concat([
    Buffer.from(`Q\nq\n/NayWmG gs\n0.55 g\nBT\n/NayWmF ${num(size)} Tf\n${num(cos)} ${num(sin)} ${num(-sin)} ${num(cos)} ${num(cx - half * cos)} ${num(cy - half * sin)} Tm\n(`, 'latin1'),
    pdfString(text),
    Buffer.from(`) Tj\nET\nBT\n/NayWmF 7 Tf\n1 0 0 1 ${num(x0 + 18)} ${num(y0 + 12)} Tm\n(`, 'latin1'),
    pdfString(text),
    Buffer.from(') Tj\nET\nQ\n', 'latin1'),
  ]);
  return body;
}

module.exports = { overlayStream, boxOf, pdfString, unitWidth };
