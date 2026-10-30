'use strict';

/**
 * Remoção de metadados de imagem (M9-D247 3.1 item 2d): EXIF (inclui o GPS), XMP e IPTC saem do JPEG (segmentos APP1 e APP13), do PNG (blocos eXIf, tEXt, iTXt, zTXt e tIME) e do WebP
 * (blocos EXIF e XMP, com o tamanho do RIFF e os sinalizadores do VP8X ajustados). O perfil de cor (ICC) fica. Outros tipos voltam como entraram. Devolve { buffer, stripped }.
 */
function stripJpeg(b) {
  const partes = [b.subarray(0, 2)];
  let pos = 2;
  let removeu = false;
  while (pos + 4 <= b.length) {
    if (b[pos] !== 0xff) break;
    const marcador = b[pos + 1];
    if (marcador === 0xda) break; // início dos dados da imagem
    const tamanho = b.readUInt16BE(pos + 2);
    const segmento = b.subarray(pos, pos + 2 + tamanho);
    if (marcador === 0xe1 || marcador === 0xed) removeu = true; else partes.push(segmento);
    pos += 2 + tamanho;
  }
  partes.push(b.subarray(pos));
  return { buffer: removeu ? Buffer.concat(partes) : b, stripped: removeu };
}

const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);
function stripPng(b) {
  const partes = [b.subarray(0, 8)];
  let pos = 8;
  let removeu = false;
  while (pos + 12 <= b.length) {
    const tamanho = b.readUInt32BE(pos);
    const tipo = b.toString('latin1', pos + 4, pos + 8);
    const bloco = b.subarray(pos, pos + 12 + tamanho);
    if (PNG_DROP.has(tipo)) removeu = true; else partes.push(bloco);
    pos += 12 + tamanho;
  }
  return { buffer: removeu ? Buffer.concat(partes) : b, stripped: removeu };
}

function stripWebp(b) {
  const partes = [b.subarray(0, 12)];
  let pos = 12;
  let removeu = false;
  while (pos + 8 <= b.length) {
    const tipo = b.toString('latin1', pos, pos + 4);
    const tamanho = b.readUInt32LE(pos + 4);
    const total = 8 + tamanho + (tamanho % 2);
    let bloco = b.subarray(pos, pos + total);
    if (tipo === 'EXIF' || tipo === 'XMP ') removeu = true;
    else {
      if (tipo === 'VP8X') { bloco = Buffer.from(bloco); bloco[8] &= ~(0x08 | 0x04); }
      partes.push(bloco);
    }
    pos += total;
  }
  if (!removeu) return { buffer: b, stripped: false };
  const saida = Buffer.concat(partes);
  saida.writeUInt32LE(saida.length - 8, 4);
  return { buffer: saida, stripped: true };
}

function stripMetadata(buffer, mime) {
  try {
    if (mime === 'image/jpeg') return stripJpeg(buffer);
    if (mime === 'image/png') return stripPng(buffer);
    if (mime === 'image/webp') return stripWebp(buffer);
  } catch { /* imagem que não abre inteira: segue como veio (o tipo já foi conferido) */ }
  return { buffer, stripped: false };
}

module.exports = { stripMetadata };
