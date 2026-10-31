'use strict';

// Arquivos de teste da M9-D920 (não é teste): PDF do pdfkit, PDF com fluxo de referência cruzada e fluxo de objetos, PNG e JPEG mínimos.
const zlib = require('node:zlib');
const PDFDocument = require('pdfkit');

/** PDF do pdfkit (tabela de referência cruzada clássica) com `pages` páginas; cada página tem o texto "Contrato <n>". */
function pdfBuffer(pages = 1) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    for (let i = 1; i <= pages; i += 1) { if (i > 1) doc.addPage(); doc.text(`Contrato ${i}`); }
    doc.end();
  });
}

/** Aplica o preditor PNG "Up" (12) linha a linha, como os leitores de PDF esperam num fluxo XRef. */
function predictUp(rows, width) {
  const out = [];
  rows.forEach((row, r) => {
    out.push(2);
    for (let i = 0; i < width; i += 1) out.push((row[i] - (r > 0 ? rows[r - 1][i] : 0)) & 255);
  });
  return Buffer.from(out);
}

/**
 * PDF de 1 página no formato moderno: o catálogo, a árvore de páginas e a página dentro de um fluxo de objetos (ObjStm, objeto 5) e a referência cruzada num fluxo (XRef,
 * objeto 6, FlateDecode com preditor 12). Só o conteúdo (objeto 4) e os dois fluxos são objetos soltos.
 */
function xrefStreamPdf() {
  const head = Buffer.from('%PDF-1.5\n', 'latin1');
  const content = Buffer.from('BT /F1 12 Tf 72 700 Td (Contrato moderno) Tj ET', 'latin1');
  const obj4 = Buffer.from(`4 0 obj\n<</Length ${content.length}>>\nstream\n${content.toString('latin1')}\nendstream\nendobj\n`, 'latin1');
  const bodies = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', '<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 300]/Contents 4 0 R/Resources<<>>>>'];
  let offset = 0;
  const pairs = bodies.map((b) => { const p = `${bodies.indexOf(b) + 1} ${offset}`; offset += b.length + 1; return p; });
  const header = `${pairs.join(' ')}\n`;
  const packed = zlib.deflateSync(Buffer.from(header + bodies.join('\n'), 'latin1'));
  const obj5Pos = head.length + obj4.length;
  const obj5 = Buffer.concat([Buffer.from(`5 0 obj\n<</Type/ObjStm/N 3/First ${header.length}/Filter/FlateDecode/Length ${packed.length}>>\nstream\n`, 'latin1'), packed, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
  const obj6Pos = obj5Pos + obj5.length;
  const rows = [[0, 0, 0, 0], [2, 0, 5, 0], [2, 0, 5, 1], [2, 0, 5, 2], [1, (head.length >> 8) & 255, head.length & 255, 0], [1, (obj5Pos >> 8) & 255, obj5Pos & 255, 0], [1, (obj6Pos >> 8) & 255, obj6Pos & 255, 0]];
  const data = zlib.deflateSync(predictUp(rows, 4));
  const obj6 = Buffer.concat([
    Buffer.from(`6 0 obj\n<</Type/XRef/Size 7/W[1 2 1]/Root 1 0 R/Filter/FlateDecode/DecodeParms<</Predictor 12/Columns 4>>/Length ${data.length}>>\nstream\n`, 'latin1'),
    data, Buffer.from(`\nendstream\nendobj\nstartxref\n${obj6Pos}\n%%EOF\n`, 'latin1'),
  ]);
  return Buffer.concat([head, obj4, obj5, obj6]);
}

const crc = (buf) => { const v = Buffer.alloc(4); v.writeUInt32BE(zlib.crc32(buf) >>> 0); return v; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, 'latin1'), data]); return Buffer.concat([len, body, crc(body)]); };

/** PNG 2 x 2 válido (RGB). */
function pngBuffer() {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0, 0, 255, 0]);
  const rows = Buffer.concat([Buffer.from([0]), raw.subarray(0, 6), Buffer.from([0]), raw.subarray(6, 12)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/** JPEG mínimo (cabeçalho com SOF0 de 1 x 1, 3 componentes): o pdfkit só lê as dimensões e embute os bytes. */
function jpegBuffer() {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, 0, 1, 0, 1, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
}

module.exports = { pdfBuffer, xrefStreamPdf, pngBuffer, jpegBuffer };
