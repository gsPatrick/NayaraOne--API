'use strict';

const { plain, safeText, NUMBER } = require('./cells');
const { buildZip } = require('./zip');

const isXmlChar = (ch) => { const code = ch.charCodeAt(0); return code === 9 || code === 10 || code === 13 || code >= 32; };
const esc = (text) => [...String(text)].filter(isXmlChar).join('').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const colName = (index) => { let n = index; let out = ''; do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0); return out; };

const textCell = (ref, text, style) => `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${esc(text)}</t></is></c>`;

function cellXml(ref, column, value) {
  if (column.numeric && NUMBER.test(plain(value))) return `<c r="${ref}"><v>${plain(value)}</v></c>`;
  return textCell(ref, safeText(value, false), null);
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment textRotation="45" vertical="bottom"/></xf></cellXfs></styleSheet>`;

/**
 * Planilha XLSX (um arquivo zip de XML, sem biblioteca externa). Com marca d'água: a primeira linha traz o texto girado a 45 graus (diagonal) acima do cabeçalho e o
 * texto também vai no cabeçalho e no rodapé de impressão (M9-D822 §3.2 item 4). `watermarkText` é o texto já preenchido ou null.
 */
function renderXlsx({ columns, rows, watermarkText, title = 'Exportação' }) {
  const out = [];
  let rowNumber = 1;
  if (watermarkText) { out.push(`<row r="${rowNumber}" ht="90" customHeight="1">${textCell(`A${rowNumber}`, watermarkText, 2)}</row>`); rowNumber += 1; }
  out.push(`<row r="${rowNumber}">${columns.map((c, i) => textCell(`${colName(i)}${rowNumber}`, safeText(c.label), 1)).join('')}</row>`);
  for (const row of rows) {
    rowNumber += 1;
    out.push(`<row r="${rowNumber}">${columns.map((c, i) => cellXml(`${colName(i)}${rowNumber}`, c, row[c.key])).join('')}</row>`);
  }
  const marks = watermarkText ? `<headerFooter><oddHeader>&amp;C${esc(watermarkText)}</oddHeader><oddFooter>&amp;C${esc(watermarkText)}</oddFooter></headerFooter>` : '';
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${out.join('')}</sheetData>${marks}</worksheet>`;
  const parts = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(title).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/styles.xml', STYLES],
    ['xl/worksheets/sheet1.xml', sheet],
  ];
  return buildZip(parts.map(([name, xml]) => ({ name, data: Buffer.from(xml, 'utf8') })));
}

module.exports = { renderXlsx };
