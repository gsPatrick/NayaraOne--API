'use strict';

const { govError } = require('../../governance.errors');
const { stampPdf } = require('./pdf.stamp');
const { imageToWatermarkedPdf } = require('./watermark.image');

/**
 * Marca d'água de arquivo baixado (M9-D920 §3.4; a regra e o padrão desligado são da M9-D820). Gerada na hora sobre uma cópia: o original guardado e o hash dele não mudam.
 *  - PDF: atualização incremental com a marca em todas as páginas.
 *  - JPEG e PNG: saem como PDF de uma página com a marca (o pdfkit não decodifica imagem, e este é o único jeito de marcar sem dependência nova).
 *  - texto/CSV: linha final com a marca.
 * Qualquer outro tipo (Office, áudio, vídeo, zip, GIF/WebP/HEIC) não aceita marca: `canMark` é falso e `markFile` recusa. Falha ao marcar recusa o download (422).
 */
const TEXT_TYPES = ['text/csv'];
const IMAGE_TYPES = ['image/jpeg', 'image/png'];
const lower = (mimeType) => String(mimeType || '').toLowerCase();

const canMark = (mimeType) => lower(mimeType) === 'application/pdf' || IMAGE_TYPES.includes(lower(mimeType)) || TEXT_TYPES.includes(lower(mimeType));

const unsupported = () => govError(422, 'GOV_FILE_WATERMARK_UNSUPPORTED', 'Este tipo de arquivo não aceita marca d\'água.');
const failed = (reason) => govError(422, 'GOV_FILE_WATERMARK_FAILED', 'Não foi possível aplicar a marca d\'água; o download foi recusado.', { reason });

const stripExtension = (name) => String(name || 'arquivo').replace(/\.[A-Za-z0-9]{1,5}$/, '');

/** Devolve { buffer, mimeType, fileName }. `text` é o texto já preenchido (usuário e data). */
async function markFile({ buffer, mimeType, fileName }, text, { maxPages = 500 } = {}) {
  const type = lower(mimeType);
  if (!canMark(type)) throw unsupported();
  try {
    if (type === 'application/pdf') return { buffer: stampPdf(buffer, text, { maxPages }), mimeType: 'application/pdf', fileName };
    if (IMAGE_TYPES.includes(type)) return { buffer: await imageToWatermarkedPdf(buffer, text), mimeType: 'application/pdf', fileName: `${stripExtension(fileName)}.pdf` };
    const sep = buffer.length && buffer[buffer.length - 1] !== 10 ? '\n' : '';
    return { buffer: Buffer.concat([buffer, Buffer.from(`${sep}# ${text}\n`, 'utf8')]), mimeType, fileName };
  } catch (error) {
    if (error && error.pdfUnsupported) throw unsupported();
    throw failed(error && error.message ? String(error.message).slice(0, 120) : 'erro');
  }
}

module.exports = { canMark, markFile, unsupported, failed };
