'use strict';

const PDFDocument = require('pdfkit');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const kindOf = (buffer) => {
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  return null;
};

/**
 * Imagem com marca d'água (M9-D920 §3.4): o pdfkit só embute JPEG e PNG sem decodificar, então a imagem sai dentro de um PDF de uma página (a marca na diagonal, translúcida, e
 * o texto também no rodapé). O original guardado não muda. Outro formato de imagem (GIF, WebP, HEIC) não aceita marca.
 */
function imageToWatermarkedPdf(buffer, text) {
  const kind = kindOf(buffer);
  if (!kind) throw Object.assign(new Error('formato de imagem sem suporte à marca'), { pdfUnsupported: true });
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 24, info: { Producer: 'Nayara One', Subject: text, Keywords: 'marca-dagua' } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      const area = { width: doc.page.width - 48, height: doc.page.height - 48 - 14 };
      doc.image(buffer, 24, 24, { fit: [area.width, area.height], align: 'center', valign: 'center' });
      doc.save();
      doc.fillColor('#808080').fillOpacity(0.3).fontSize(Math.max(10, Math.min(34, (doc.page.width * 0.9) / Math.max(text.length * 0.55, 1))));
      doc.rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] });
      const width = doc.widthOfString(text);
      doc.text(text, (doc.page.width - width) / 2, doc.page.height / 2 - 12, { lineBreak: false });
      doc.restore();
      doc.page.margins.bottom = 0; // o rodapé fica abaixo da margem: sem isto o pdfkit abriria outra página
      doc.fillColor('#444444').fillOpacity(1).fontSize(7).text(text, 24, doc.page.height - 28, { width: doc.page.width - 48, lineBreak: false });
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = { imageToWatermarkedPdf, kindOf };
