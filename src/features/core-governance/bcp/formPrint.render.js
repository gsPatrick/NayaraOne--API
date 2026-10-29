'use strict';

const PDFDocument = require('pdfkit');

const MARGIN = 40;
const HEADER_FIELDS = ['Data e hora da ocorrência', 'Preenchido por (nome)', 'Assinatura'];
const HINTS = {
  CENTS: 'valor em centavos, só números (R$ 1.250,00 = 125000)',
  DATE: 'dia/mês/ano',
  DATETIME: 'dia/mês/ano e hora',
  PERSON_DOC: 'CPF ou CNPJ',
  PHONE: 'com DDD',
};

function drawLine(doc, x, y, width) {
  doc.save().lineWidth(0.6).strokeColor('#555555').moveTo(x, y).lineTo(x + width, y).stroke().restore();
}

/** Uma folha: número (impresso ou em branco), cabeçalho fixo (setor, tipo, data e hora, quem preencheu, assinatura) e um espaço de escrita por campo. */
function drawSheet(doc, { template, sectorLabel, reference, page, total }) {
  const width = doc.page.width - MARGIN * 2;
  doc.font('Helvetica').fontSize(8).fillColor('#444444').text('Nayara One · Formulário contingencial (continuidade operacional)', MARGIN, MARGIN, { width, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#000000').text(template.title, MARGIN, MARGIN + 14, { width, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(13).text(`Número: ${reference || '_______________________'}`, MARGIN, MARGIN + 36, { width, lineBreak: false });
  doc.font('Helvetica').fontSize(9).text(`Setor: ${sectorLabel} (${template.sector})    Tipo: ${template.formType}`, MARGIN, MARGIN + 56, { width, lineBreak: false });
  let y = MARGIN + 76;
  for (const label of HEADER_FIELDS) {
    doc.font('Helvetica-Bold').fontSize(9).text(label, MARGIN, y, { width: 170, lineBreak: false });
    drawLine(doc, MARGIN + 175, y + 10, width - 175);
    y += 22;
  }
  y += 6;
  doc.save().lineWidth(1).strokeColor('#000000').moveTo(MARGIN, y).lineTo(MARGIN + width, y).stroke().restore();
  y += 8;
  const footer = doc.page.height - MARGIN - 14;
  const rows = template.fields.length;
  const rowHeight = Math.min(46, (footer - y - 6) / Math.max(rows, 1));
  for (const field of template.fields) {
    const mark = field.required ? ' *' : '';
    const hint = HINTS[field.type] ? `  (${HINTS[field.type]})` : '';
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000000').text(`${field.label}${mark}`, MARGIN, y, { width, lineBreak: false, continued: Boolean(hint) });
    if (hint) doc.font('Helvetica').fontSize(7.5).fillColor('#555555').text(hint, { lineBreak: false });
    if (field.type === 'ENUM') {
      doc.font('Helvetica').fontSize(9).fillColor('#000000').text(field.enum.map((option) => `(   ) ${option}`).join('      '), MARGIN, y + 13, { width, lineBreak: false });
    } else {
      drawLine(doc, MARGIN, y + rowHeight - 6, width);
    }
    y += rowHeight;
  }
  doc.font('Helvetica').fontSize(8).fillColor('#444444').text(`* campo obrigatório · Folha ${page} de ${total}`, MARGIN, footer, { width, align: 'right', lineBreak: false });
}

/** PDF A4 retrato com uma folha por número (ou uma folha em branco quando `references` é [null]). */
function renderSheets({ template, sectorLabel, references }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, info: { Title: `${template.title} (${template.sector})`, Producer: 'Nayara One' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    references.forEach((reference, i) => {
      if (i > 0) doc.addPage();
      drawSheet(doc, { template, sectorLabel, reference, page: i + 1, total: references.length });
    });
    doc.end();
  });
}

module.exports = { renderSheets };
