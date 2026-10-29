'use strict';

const { parsePdf } = require('./pdf');
const { parseDocx } = require('./docx');
const { parsePlainText } = require('./plainText');

/**
 * Leitura do texto de um documento (M9-D022, passo 5): PDF, DOCX e texto simples. O tipo vem do CONTEÚDO (assinatura do arquivo), não só do
 * mime declarado. Retorna { text, activeDiscarded, format } ou lança Error com `code`: PARSE_UNSUPPORTED (tipo não lido: imagem e áudio são
 * do OCR da M9-D040), ou o código do leitor (PDF_UNREADABLE, ZIP_*, DOCX_INVALID, TEXT_UNREADABLE). O limite de tamanho é o do módulo de arquivos.
 */
const TEXT_MIMES = /^(?:text\/(?:plain|markdown|csv)|application\/(?:csv|markdown))$/i;
const startsWith = (buf, txt) => buf.length >= txt.length && buf.toString('latin1', 0, txt.length) === txt;

function detectFormat(buffer, mimeType) {
  const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
  if (startsWith(buffer, '%PDF-')) return 'pdf';
  if (startsWith(buffer, 'PK\u0003\u0004')) return 'docx';
  if (TEXT_MIMES.test(mime)) return 'txt';
  return null;
}

function parseDocument(buffer, { mimeType, maxBytes }) {
  const format = detectFormat(buffer, mimeType);
  if (!format) throw Object.assign(new Error('PARSE_UNSUPPORTED'), { code: 'PARSE_UNSUPPORTED' });
  const readers = { pdf: parsePdf, docx: parseDocx, txt: parsePlainText };
  return { ...readers[format](buffer, { maxBytes }), format };
}

module.exports = { parseDocument, detectFormat };
