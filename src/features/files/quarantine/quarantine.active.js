'use strict';

const { entriesOf } = require('./quarantine.zip');

/** Conteúdo ativo (M9-D247 3.1 itens 2e e 2f). PDF: JavaScript, arquivo embutido, ação de lançar programa ou mídia rica. Office (docx/xlsx): projeto de macro VBA ou tipo "macro habilitado". Devolve o motivo ou null. */
const PDF_ATIVO = [/\/JavaScript\b/, /\/JS\b/, /\/EmbeddedFile\b/, /\/Launch\b/, /\/RichMedia\b/, /\/SubmitForm\b/];

function pdfActiveContent(buffer) {
  const texto = buffer.toString('latin1');
  return PDF_ATIVO.some((r) => r.test(texto)) ? 'PDF_ACTIVE_CONTENT' : null;
}

function officeMacros(buffer) {
  const nomes = (entriesOf(buffer) || []).map((e) => e.name.toLowerCase());
  if (nomes.some((n) => n.endsWith('vbaproject.bin') || n.includes('/vbadata.xml') || n.endsWith('.vba'))) return 'OFFICE_MACROS';
  return null;
}

const OFFICE = ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];

function activeContent(buffer, detected) {
  if (detected === 'application/pdf') return pdfActiveContent(buffer);
  if (OFFICE.includes(detected)) return officeMacros(buffer);
  return null;
}

module.exports = { activeContent };
