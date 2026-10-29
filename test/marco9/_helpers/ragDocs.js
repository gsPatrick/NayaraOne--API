'use strict';

// Documentos de teste do RAG (M9-D022): PDF e DOCX montados à mão, em memória, e os textos com credencial fictícia montados
// em tempo de execução (nenhum segredo, nem fictício, fica escrito em arquivo versionado).

const zlib = require('node:zlib');

const escapePdf = (s) => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** PDF mínimo com uma página; `linhas` viram operadores Tj. `js` acrescenta abertura automática com JavaScript; `flate` comprime o fluxo. */
function montarPdf(linhas, { js = false, flate = false } = {}) {
  const conteudo = `BT /F1 12 Tf 72 720 Td ${linhas.map((l, i) => `${i ? '0 -14 Td ' : ''}(${escapePdf(l)}) Tj`).join(' ')} ET`;
  const fluxo = flate ? zlib.deflateSync(Buffer.from(conteudo, 'latin1')).toString('latin1') : conteudo;
  const objs = [
    `<< /Type /Catalog /Pages 2 0 R${js ? ' /OpenAction 6 0 R' : ''} >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${fluxo.length}${flate ? ' /Filter /FlateDecode' : ''} >>\nstream\n${fluxo}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  if (js) objs.push('<< /S /JavaScript /JS (app.alert\\(\'EXECUTAR_SCRIPT_MALICIOSO\'\\);) >>');
  const corpo = objs.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj\n`).join('');
  return Buffer.from(`%PDF-1.4\n${corpo}trailer\n<< /Root 1 0 R /Size ${objs.length + 1} >>\n%%EOF\n`, 'latin1');
}

function crc(buf) {
  return zlib.crc32(buf) >>> 0;
}

/** ZIP mínimo (entradas deflate) para montar o DOCX de teste. */
function montarZip(entradas) {
  const locais = [];
  const centrais = [];
  let pos = 0;
  for (const [nome, conteudo] of Object.entries(entradas)) {
    const dados = Buffer.from(conteudo, 'utf8');
    const comp = zlib.deflateRawSync(dados);
    const nomeBuf = Buffer.from(nome, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc(dados), 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(dados.length, 22); local.writeUInt16LE(nomeBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc(dados), 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(dados.length, 24); central.writeUInt16LE(nomeBuf.length, 28);
    central.writeUInt32LE(pos, 42);
    locais.push(local, nomeBuf, comp);
    centrais.push(central, nomeBuf);
    pos += 30 + nomeBuf.length + comp.length;
  }
  const dir = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(Object.keys(entradas).length, 8); fim.writeUInt16LE(Object.keys(entradas).length, 10);
  fim.writeUInt32LE(dir.length, 12); fim.writeUInt32LE(pos, 16);
  return Buffer.concat([...locais, dir, fim]);
}

const xmlTexto = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** DOCX com parágrafos; `{ titulo }` vira estilo Heading1. `macro` acrescenta um projeto VBA e `objeto` um objeto incorporado. */
function montarDocx(paragrafos, { macro = false, objeto = false } = {}) {
  const corpo = paragrafos.map((p) => (typeof p === 'string'
    ? `<w:p><w:r><w:t>${xmlTexto(p)}</w:t></w:r></w:p>`
    : `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${xmlTexto(p.titulo)}</w:t></w:r></w:p>`)).join('');
  const entradas = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    'word/document.xml': `<?xml version="1.0"?><w:document><w:body>${corpo}</w:body></w:document>`,
  };
  if (macro) entradas['word/vbaProject.bin'] = 'Sub AutoOpen() : Shell "EXECUTAR_MACRO_MALICIOSA" : End Sub';
  if (objeto) entradas['word/embeddings/oleObject1.bin'] = 'OBJETO_INCORPORADO';
  return montarZip(entradas);
}

/** Textos com credencial fictícia montados na hora (o varredor de segredos do CI não vê nada escrito no arquivo). */
const segredos = {
  chavePrivada: () => ['-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx9fakefakefakefakefakefake\nfakefakefakefakefakefakefakefakefakefake\n-----END ', 'RSA PRIVATE KEY-----'].join(''),
  chaveAws: () => `AKIA${'IOSFODNN7'}${'EXAMPLE'}`,
  conexao: () => `${'postgres'}://app_user:${'s3nh4Fict1cia'}@db.interno.example:5432/erp`,
  senha: () => `${'senha'}: ${'Troque-Me-123456'}`,
};

module.exports = { montarPdf, montarDocx, montarZip, segredos };
