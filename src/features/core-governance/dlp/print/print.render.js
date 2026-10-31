'use strict';

const PDFDocument = require('pdfkit');

const MARGIN = 48;
const plain = (value) => {
  if (value === null || value === undefined) return '—';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
};

/** Linhas "campo: valor" do dado, com listas e objetos aninhados em recuo. */
function toLines(value, label = '', depth = 0, out = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => toLines(item, `${label} ${index + 1}`.trim(), depth, out));
  } else if (value && typeof value === 'object' && !(value instanceof Date)) {
    if (label) out.push({ depth, text: label, bold: true });
    for (const [key, inner] of Object.entries(value)) toLines(inner, key, label ? depth + 1 : depth, out);
  } else out.push({ depth, text: `${label}: ${plain(value)}` });
  return out;
}

/** Marca d'água diagonal (mesmo desenho da exportação em PDF, M9-D822): cinza claro e translúcido em toda página. */
function stampWatermark(doc, text) {
  doc.save();
  doc.fillColor('#b0b0b0').fillOpacity(0.28).fontSize(Math.max(10, Math.min(30, (doc.page.width * 0.85) / Math.max(text.length * 0.55, 1))));
  doc.rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] });
  doc.text(text, (doc.page.width - doc.widthOfString(text)) / 2, doc.page.height / 2 - 14, { lineBreak: false });
  doc.restore();
}

/**
 * PDF A4 da visão de impressão (M9-D920 §3.1), gerado no servidor: título, os campos do recurso e, em TODA página, o rodapé fixo (`footer`, já preenchido com quem imprimiu, quando e o
 * documento) e a marca d'água diagonal quando `watermarkText` vem preenchido. `generatedAt` vai nos metadados.
 */
function renderPrintPdf({ title, data, footer, watermarkText }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: MARGIN, left: MARGIN, right: MARGIN, bottom: MARGIN + 24 }, bufferPages: true, info: { Title: title, Producer: 'Nayara One', Subject: footer } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.font('Helvetica-Bold').fontSize(15).text(title, MARGIN, MARGIN);
    doc.moveDown(0.8);
    for (const line of toLines(data)) {
      doc.font(line.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).text(line.text, MARGIN + line.depth * 14, undefined, { width: doc.page.width - MARGIN * 2 - line.depth * 14 });
    }
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(range.start + i);
      if (watermarkText) stampWatermark(doc, watermarkText);
      doc.page.margins.bottom = 0; // o rodapé fica abaixo da margem de leitura: sem isto o pdfkit abriria outra página
      doc.font('Helvetica').fontSize(8).fillColor('#444444').fillOpacity(1).text(`${footer}  ·  página ${i + 1} de ${range.count}`, MARGIN, doc.page.height - MARGIN, { width: doc.page.width - MARGIN * 2, lineBreak: false });
    }
    doc.end();
  });
}

module.exports = { renderPrintPdf, toLines };
