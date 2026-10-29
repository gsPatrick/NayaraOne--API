'use strict';

const PDFDocument = require('pdfkit');
const { plain } = require('./cells');

const MARGIN = 36;
const ROW_HEIGHT = 14;
const CLIP = 60;

const clip = (text) => (text.length > CLIP ? `${text.slice(0, CLIP - 1)}…` : text);

/** Texto diagonal em toda a página (M9-D822 §3.2 item 4), cinza claro e atrás do conteúdo seguinte. */
function stampWatermark(doc, text) {
  doc.save();
  doc.fillColor('#b0b0b0').fillOpacity(0.28).fontSize(34);
  doc.rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] });
  const width = doc.widthOfString(text);
  doc.text(text, (doc.page.width - width) / 2, doc.page.height / 2 - 20, { lineBreak: false });
  doc.restore();
}

/** Tabela em PDF A4 paisagem: título, cabeçalho repetido em cada página, rodapé com a página; a marca d'água (texto já preenchido) vai em todas as páginas e nos metadados. */
function renderPdf({ columns, rows, title, watermarkText, generatedAt }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGIN, bufferPages: true, info: { Title: title, Producer: 'Nayara One', ...(watermarkText ? { Subject: watermarkText, Keywords: 'marca-dagua' } : {}) } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const usable = doc.page.width - MARGIN * 2;
    const colWidth = usable / Math.max(columns.length, 1);
    const drawRow = (values, bold) => {
      if (doc.y + ROW_HEIGHT > doc.page.height - MARGIN - 20) { doc.addPage(); drawHeader(); }
      const y = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
      values.forEach((value, i) => doc.text(clip(value), MARGIN + i * colWidth, y, { width: colWidth - 4, height: ROW_HEIGHT, lineBreak: false }));
      doc.y = y + ROW_HEIGHT;
    };
    function drawHeader() { drawRow(columns.map((c) => c.label), true); }
    doc.font('Helvetica-Bold').fontSize(13).text(title, MARGIN, MARGIN);
    doc.font('Helvetica').fontSize(8).text(`Gerado em ${generatedAt}`, MARGIN, doc.y + 2);
    doc.y += 8;
    drawHeader();
    for (const row of rows) drawRow(columns.map((c) => plain(row[c.key])), false);
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(range.start + i);
      if (watermarkText) stampWatermark(doc, watermarkText);
      doc.font('Helvetica').fontSize(8).fillColor('#444444').text(`Página ${i + 1} de ${range.count}`, MARGIN, doc.page.height - MARGIN, { width: usable, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

module.exports = { renderPdf };
