'use strict';

const { listEntries, readEntry } = require('./zipReader');

/**
 * Texto de um DOCX (word/document.xml) com títulos marcados por `# `. Conteúdo ativo é DESCARTADO e contado: projeto de macro
 * (vbaProject.bin), objetos incorporados (embeddings, OLE), controles ActiveX e os elementos <w:object>/<w:control> do corpo.
 */
const ACTIVE_ENTRY = /(?:^|\/)vbaProject\.bin$|\/embeddings\/|\/activeX\/|\/oleObject|\.(?:exe|dll|js|vbs|bat)$/i;
const ACTIVE_XML = /<w:object[\s>]|<w:control[\s>]|<w:altChunk[\s>]/gi;
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': '\'' };

const decode = (s) => s.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m]).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

function paragraphText(xml) {
  const partes = [];
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g;
  let m = re.exec(xml);
  while (m) {
    partes.push(m[1] !== undefined ? decode(m[1]) : (m[0].startsWith('<w:tab') ? '\t' : '\n'));
    m = re.exec(xml);
  }
  return partes.join('');
}

function extractText(xml) {
  const linhas = [];
  const re = /<w:p[\s>][\s\S]*?<\/w:p>/g;
  let m = re.exec(xml);
  while (m) {
    const texto = paragraphText(m[0]).trim();
    if (texto) linhas.push(/<w:pStyle\s+w:val="(?:Heading|Title|Ttulo|T[íi]tulo)/i.test(m[0]) ? `# ${texto}` : texto);
    m = re.exec(xml);
  }
  return linhas.join('\n');
}

/** parseDocx(buffer, { maxBytes }) => { text, activeDiscarded }. Erro: ZIP_INVALID / ZIP_TOO_LARGE / DOCX_INVALID. */
function parseDocx(buffer, { maxBytes }) {
  const entries = listEntries(buffer);
  const corpo = entries.find((e) => e.name === 'word/document.xml');
  if (!corpo) throw Object.assign(new Error('DOCX_INVALID'), { code: 'DOCX_INVALID' });
  const xml = readEntry(buffer, corpo, maxBytes).toString('utf8');
  const ativos = entries.filter((e) => ACTIVE_ENTRY.test(e.name)).length + (xml.match(ACTIVE_XML) || []).length;
  return { text: extractText(xml), activeDiscarded: ativos };
}

module.exports = { parseDocx };
