'use strict';

const { loadDocument } = require('./pdf.document');
const { listPages } = require('./pdf.pages');
const { overlayStream } = require('./pdf.overlay');
const { serialize } = require('./pdf.serialize');
const { isRef, isDict } = require('./pdf.lexer');

const FONT_KEY = 'NayWmF';
const GS_KEY = 'NayWmG';
const ref = (num) => ({ ref: num, gen: 0 });

/** Dicionário de recursos da página com a fonte e a transparência da marca acrescentadas (copia; nunca altera o objeto lido). */
function mergedResources(doc, inherited, fontNum, gsNum) {
  const base = doc.resolve(inherited.Resources);
  const dict = isDict(base) ? { ...base.dict } : {};
  const sub = (key, name, num) => {
    const current = doc.resolve(dict[key]);
    dict[key] = { dict: { ...(isDict(current) ? current.dict : {}), [name]: ref(num) } };
  };
  sub('Font', FONT_KEY, fontNum);
  sub('ExtGState', GS_KEY, gsNum);
  return { dict };
}

function contentsList(doc, value) {
  if (value === undefined || value === null) return [];
  const target = isRef(value) ? doc.resolve(value) : value;
  if (Array.isArray(target)) return target;
  return [value];
}

const objectBytes = (num, gen, body) => Buffer.concat([Buffer.from(`${num} ${gen} obj\n`, 'latin1'), Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'), Buffer.from('\nendobj\n', 'latin1')]);
const streamObject = (data) => Buffer.concat([Buffer.from(`<</Length ${data.length}>>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]);

function trailerEntries(doc, size, prev) {
  const t = doc.trailer;
  const parts = [`/Size ${size}`, `/Root ${serialize(t.Root)}`, `/Prev ${prev}`];
  if (t.Info) parts.push(`/Info ${serialize(t.Info)}`);
  if (t.ID) parts.push(`/ID ${serialize(t.ID)}`);
  return parts;
}

function classicXref(objects, doc, startOfXref, size) {
  const rows = objects.map((o) => `${o.num} 1\n${String(o.offset).padStart(10, '0')} ${String(o.gen).padStart(5, '0')} n \n`).join('');
  return Buffer.from(`xref\n${rows}trailer\n<<${trailerEntries(doc, size, doc.info.lastXrefOffset).join(' ')}>>\nstartxref\n${startOfXref}\n%%EOF\n`, 'latin1');
}

function streamXref(objects, doc, startOfXref, size, xrefNum) {
  const all = [...objects, { num: xrefNum, offset: startOfXref, gen: 0 }].sort((a, b) => a.num - b.num);
  const data = Buffer.alloc(all.length * 7);
  all.forEach((o, i) => { data[i * 7] = 1; data.writeUInt32BE(o.offset, i * 7 + 1); data.writeUInt16BE(o.gen, i * 7 + 5); });
  const index = all.map((o) => `${o.num} 1`).join(' ');
  const head = `${xrefNum} 0 obj\n<</Type/XRef /W[1 4 2] /Index[${index}] ${trailerEntries(doc, size, doc.info.lastXrefOffset).join(' ')} /Length ${data.length}>>\nstream\n`;
  return Buffer.concat([Buffer.from(head, 'latin1'), data, Buffer.from(`\nendstream\nendobj\nstartxref\n${startOfXref}\n%%EOF\n`, 'latin1')]);
}

/**
 * Marca d'água em PDF existente (M9-D920 §3.4): devolve OUTRO buffer, com o original intacto no começo e uma atualização incremental no fim (a página ganha um fluxo de conteúdo a
 * mais, a fonte e a transparência da marca). `text` vai na diagonal de cada página e no rodapé. Erro com `pdfUnsupported` = estrutura que a marca não alcança (cifrado, filtro
 * desconhecido, árvore inválida, páginas demais).
 */
function stampPdf(original, text, { maxPages = 500 } = {}) {
  const doc = loadDocument(original);
  const pages = listPages(doc, maxPages);
  let next = doc.nextObjectNumber;
  const fontNum = next; next += 1;
  const gsNum = next; next += 1;
  const prefixNum = next; next += 1;
  const appended = [];
  const add = (num, gen, body) => appended.push({ num, gen, body });
  add(fontNum, 0, serialize({ dict: { Type: { name: 'Font' }, Subtype: { name: 'Type1' }, BaseFont: { name: 'Helvetica' }, Encoding: { name: 'WinAnsiEncoding' } } }));
  add(gsNum, 0, serialize({ dict: { Type: { name: 'ExtGState' }, ca: 0.3, CA: 0.3 } }));
  add(prefixNum, 0, streamObject(Buffer.from('q\n', 'latin1')));
  for (const page of pages) {
    const overlayNum = next; next += 1;
    add(overlayNum, 0, streamObject(overlayStream(text, doc.resolve(page.inherited.MediaBox))));
    const dict = { ...page.dict, Resources: mergedResources(doc, page.inherited, fontNum, gsNum), Contents: [ref(prefixNum), ...contentsList(doc, page.dict.Contents), ref(overlayNum)] };
    add(page.num, page.gen, serialize({ dict }));
  }
  const useStream = doc.info.lastXrefKind === 'stream';
  const xrefNum = useStream ? next : null;
  const size = useStream ? next + 1 : next;
  const lead = original[original.length - 1] === 10 ? Buffer.alloc(0) : Buffer.from('\n', 'latin1');
  const chunks = [lead];
  let offset = original.length + lead.length;
  const placed = appended.map((o) => {
    const bytes = objectBytes(o.num, o.gen, o.body);
    const entry = { num: o.num, gen: o.gen, offset };
    chunks.push(bytes); offset += bytes.length;
    return entry;
  });
  const xref = useStream ? streamXref(placed, doc, offset, size, xrefNum) : classicXref(placed, doc, offset, size);
  return Buffer.concat([original, ...chunks, xref]);
}

module.exports = { stampPdf };
