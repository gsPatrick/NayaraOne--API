'use strict';

const zlib = require('node:zlib');

/**
 * Texto de um PDF simples (fontes de 1 byte por caractere), sem biblioteca externa. Lê os fluxos de conteúdo de página (os que têm BT/ET),
 * expande FlateDecode com teto de saída e junta as strings dos operadores Tj, TJ, ' e ". Conteúdo ativo (JavaScript, abertura
 * automática, lançamento, arquivo incorporado, formulário) é descartado e contado: nunca é executado nem lido como texto.
 * PDF cifrado, fonte com glifos de 2 bytes sem mapa de caracteres ou fluxo ilegível = erro PDF_UNREADABLE (OCR é da M9-D040).
 */
const ACTIVE = /\/(?:JavaScript|JS|OpenAction|Launch|EmbeddedFile|RichMedia|XFA|SubmitForm|ImportData|AA)(?![A-Za-z0-9])/g;
const SKIP_DICT = /\/(?:Subtype\s*\/Image|Subtype\s*\/Form|JavaScript|EmbeddedFile|Type\s*\/ObjStm|Type\s*\/XRef|Type\s*\/EmbeddedFile)/;

const unreadable = () => Object.assign(new Error('PDF_UNREADABLE'), { code: 'PDF_UNREADABLE' });

function literalString(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c !== '\\') { bytes.push(s.charCodeAt(i) & 0xff); continue; }
    i += 1;
    const n = s[i];
    const simples = { n: 10, r: 13, t: 9, b: 8, f: 12 };
    if (n in simples) bytes.push(simples[n]);
    else if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(s[i + 1] || '')) { i += 1; oct += s[i]; }
      bytes.push(parseInt(oct, 8) & 0xff);
    } else if (n !== '\n' && n !== '\r') bytes.push(n.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes).toString('latin1');
}

const hexString = (h) => {
  const limpo = h.replace(/\s+/g, '');
  return Buffer.from(limpo.length % 2 ? `${limpo}0` : limpo, 'hex').toString('latin1');
};

/** Texto de um fluxo de conteúdo (já expandido). */
function contentText(content) {
  const out = [];
  const re = /\(((?:\\[\s\S]|[^\\()])*)\)|<([0-9A-Fa-f\s]*)>|\[|\]|(-?\d*\.?\d+)|(T\*|Td|TD|ET|Tj|TJ|'|")|\/[^\s/[\]()<>]+/g;
  let pilha = [];
  let dentroArray = false;
  let m = re.exec(content);
  while (m) {
    if (m[1] !== undefined) (dentroArray ? pilha : (pilha = [])).push(literalString(m[1]));
    else if (m[2] !== undefined) (dentroArray ? pilha : (pilha = [])).push(hexString(m[2]));
    else if (m[0] === '[') { dentroArray = true; pilha = []; } else if (m[0] === ']') dentroArray = false;
    else if (m[3] !== undefined) { if (dentroArray && Number(m[3]) < -200) pilha.push(' '); } else if (m[4]) {
      const op = m[4];
      if (['Tj', 'TJ', '\'', '"'].includes(op)) { out.push(pilha.join('')); pilha = []; }
      if (['T*', 'Td', 'TD', 'ET', '\'', '"'].includes(op)) out.push('\n');
    }
    m = re.exec(content);
  }
  return out.join('').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{2,}/g, '\n');
}

function streams(raw, maxBytes) {
  const achados = [];
  const re = /stream\r?\n/g;
  let m = re.exec(raw);
  while (m) {
    const inicio = m.index + m[0].length;
    const fim = raw.indexOf('endstream', inicio);
    if (fim < 0) break;
    const dict = raw.slice(raw.lastIndexOf('obj', m.index), m.index);
    if (!SKIP_DICT.test(dict)) {
      let dados = Buffer.from(raw.slice(inicio, fim), 'latin1');
      let ok = true;
      if (/\/FlateDecode/.test(dict)) {
        try { dados = zlib.inflateSync(dados, { maxOutputLength: maxBytes }); } catch (err) {
          if (err && err.code === 'ERR_BUFFER_TOO_LARGE') throw unreadable();
          ok = false;
        }
      }
      if (ok) achados.push(dados.toString('latin1'));
    }
    re.lastIndex = fim + 9;
    m = re.exec(raw);
  }
  return achados;
}

/** parsePdf(buffer, { maxBytes }) => { text, activeDiscarded }. */
function parsePdf(buffer, { maxBytes }) {
  const raw = buffer.toString('latin1');
  if (/\/Encrypt\b/.test(raw)) throw unreadable();
  const activeDiscarded = (raw.match(ACTIVE) || []).length;
  const partes = streams(raw, maxBytes).filter((c) => /\bBT\b/.test(c) && /\bET\b/.test(c)).map(contentText);
  const text = partes.join('\n').trim();
  const imprimiveis = (text.match(/[\p{L}\p{N}\p{P}\p{Zs}\n]/gu) || []).length;
  if (text && imprimiveis / text.length < 0.7) throw unreadable();
  return { text, activeDiscarded };
}

module.exports = { parsePdf };
