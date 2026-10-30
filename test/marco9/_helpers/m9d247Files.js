'use strict';

// Fábricas de arquivos de teste da quarentena (M9-D247): ZIP montado à mão, JPEG com EXIF e GPS, PDFs com e sem script, DOCX com e sem macro, executável disfarçado e o arquivo de teste do antivírus.
const zlib = require('node:zlib');

const crc32 = (() => {
  const tabela = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  return (b) => { let c = 0xffffffff; for (const x of b) c = tabela[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
})();

/** ZIP de verdade: `entradas` = [{ name, data (Buffer), store? }]. Por padrão compacta (deflate). */
function zip(entradas) {
  const locais = []; const centrais = []; let offset = 0;
  for (const e of entradas) {
    const nome = Buffer.from(e.name);
    const dados = e.store ? e.data : zlib.deflateRawSync(e.data);
    const metodo = e.store ? 0 : 8;
    const loc = Buffer.alloc(30); loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(metodo, 8); loc.writeUInt32LE(crc32(e.data), 14); loc.writeUInt32LE(dados.length, 18); loc.writeUInt32LE(e.data.length, 22); loc.writeUInt16LE(nome.length, 26);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(metodo, 10); cen.writeUInt32LE(crc32(e.data), 16); cen.writeUInt32LE(dados.length, 20); cen.writeUInt32LE(e.data.length, 24); cen.writeUInt16LE(nome.length, 28); cen.writeUInt32LE(offset, 42);
    locais.push(loc, nome, dados); centrais.push(cen, nome);
    offset += 30 + nome.length + dados.length;
  }
  const dir = Buffer.concat(centrais);
  const fim = Buffer.alloc(22); fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(entradas.length, 8); fim.writeUInt16LE(entradas.length, 10); fim.writeUInt32LE(dir.length, 12); fim.writeUInt32LE(offset, 16);
  return Buffer.concat([...locais, dir, fim]);
}

const docx = (extra = []) => zip([{ name: '[Content_Types].xml', data: Buffer.from('<Types/>') }, { name: 'word/document.xml', data: Buffer.from('<w:document>contrato de locação</w:document>') }, ...extra]);
const docxComMacro = () => docx([{ name: 'word/vbaProject.bin', data: Buffer.from('macro') }]);
/** Bomba de descompressão: 5 MB de zeros compactados (razão de milhares para 1). */
const zipBomba = () => zip([{ name: 'zeros.bin', data: Buffer.alloc(5 * 1024 * 1024) }]);
/** ZIP dentro de ZIP, `niveis` vezes (o de fora conta como nível 1). */
function zipAninhado(niveis) { let b = zip([{ name: 'a.txt', data: Buffer.from('conteúdo') }]); for (let i = 1; i < niveis; i += 1) b = zip([{ name: `n${i}.zip`, data: b, store: true }]); return b; }

const pdf = (corpo = '') => Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n${corpo}\n%%EOF`);
const pdfComScript = () => pdf('2 0 obj\n<< /S /JavaScript /JS (app.alert(1)) >>\nendobj');

/** JPEG com um segmento EXIF que carrega GPS e câmera (marcadores ASCII fáceis de procurar), e o ICC, que deve ficar. */
function jpegComExif() {
  const exif = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from('GPSLatitude-25.4284 GPSLongitude-49.2733 Make=CameraXYZ')]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 0xff]), exif]);
  const icc = Buffer.concat([Buffer.from('ICC_PROFILE\0'), Buffer.from('perfil-de-cor')]);
  const app2 = Buffer.concat([Buffer.from([0xff, 0xe2, (icc.length + 2) >> 8, (icc.length + 2) & 0xff]), icc]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0, 0xaa, 0xbb, 0xcc, 0xff, 0xd9]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, app2, sos]);
}

const executavelDisfarcado = () => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 0x90), Buffer.from('This program cannot be run in DOS mode')]);
/** O arquivo de teste do antivírus (EICAR), montado em partes: nenhum arquivo versionado carrega a assinatura inteira. */
const eicar = () => ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!', '$H+H*'].join('');
const pdfInfectado = () => pdf(eicar());

module.exports = { zip, docx, docxComMacro, zipBomba, zipAninhado, pdf, pdfComScript, jpegComExif, executavelDisfarcado, eicar, pdfInfectado };
