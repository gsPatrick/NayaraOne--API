'use strict';

const { entriesOf, isZip } = require('./quarantine.zip');

const ascii = (b, from, to) => b.toString('latin1', from, to);

/** Tipo ABSOLUTO do arquivo pelo conteúdo (bytes mágicos), nunca pelo nome nem pelo que o remetente declarou. Executáveis e scripts voltam com tipos próprios para a recusa ser clara. */
function detectType(b) {
  if (!Buffer.isBuffer(b) || b.length < 4) return 'application/octet-stream';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return 'image/png';
  if (/^GIF8[79]a/.test(ascii(b, 0, 6))) return 'image/gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(b, 0, 1024).includes('%PDF-')) return 'application/pdf';
  if (ascii(b, 0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(b, 0, 5) === '#!AMR') return 'audio/amr';
  if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  if (ascii(b, 4, 8) === 'ftyp') {
    const marca = ascii(b, 8, 12);
    if (marca === 'qt  ') return 'video/quicktime';
    return marca === 'M4A ' || marca === 'M4B ' ? 'audio/mp4' : 'video/mp4';
  }
  if (isZip(b)) {
    const nomes = (entriesOf(b) || []).map((e) => e.name);
    if (nomes.includes('word/document.xml')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (nomes.includes('xl/workbook.xml')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    return 'application/zip';
  }
  if (b[0] === 0x4d && b[1] === 0x5a) return 'application/x-msdownload';
  if (ascii(b, 0, 4) === '\x7fELF' || b.readUInt32BE(0) === 0xcafebabe || b.readUInt32BE(0) === 0xfeedface || b.readUInt32LE(0) === 0xfeedfacf) return 'application/x-executable';
  if (ascii(b, 0, 2) === '#!') return 'text/x-script';
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'application/x-ole-storage';
  return 'application/octet-stream';
}

const EXECUTABLES = Object.freeze(['application/x-msdownload', 'application/x-executable', 'text/x-script']);

/** Famílias de tipo que o remetente costuma declarar de forma equivalente (jpg/jpeg, áudio e vídeo MP4, WebM). */
const EQUIVALENTES = Object.freeze({
  'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/mp3': 'audio/mpeg', 'audio/x-m4a': 'audio/mp4', 'audio/webm': 'video/webm', 'application/x-pdf': 'application/pdf',
  'audio/opus': 'audio/ogg', 'application/ogg': 'audio/ogg', 'video/x-matroska': 'video/webm',
});
const normalizeMime = (m) => { const base = String(m || '').split(';')[0].trim().toLowerCase(); return EQUIVALENTES[base] || base; };

/** O tipo declarado confere com o detectado? Áudio MP4 e vídeo MP4 são o mesmo contêiner. */
function sameType(declared, detected) {
  const d = normalizeMime(declared);
  if (d === detected) return true;
  return ['audio/mp4', 'video/mp4'].includes(d) && ['audio/mp4', 'video/mp4'].includes(detected);
}

module.exports = { detectType, normalizeMime, sameType, EXECUTABLES };
