'use strict';

const { isRef, isDict } = require('./pdf.lexer');

const INHERITED = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];

/** Páginas na ordem do documento, cada uma com o número do objeto, o dicionário e os atributos herdados (recursos e caixa). Passa de `limit` páginas: erro "não suportado". */
function listPages(doc, limit) {
  const root = doc.resolve(doc.trailer.Root);
  const out = [];
  const seen = new Set();
  function visit(ref, inherited, depth) {
    if (depth > 40 || seen.has(ref.ref)) throw Object.assign(new Error('árvore de páginas inválida'), { pdfUnsupported: true });
    seen.add(ref.ref);
    const node = doc.resolve(ref);
    if (!isDict(node)) return;
    const next = { ...inherited };
    for (const key of INHERITED) if (node.dict[key] !== undefined) next[key] = node.dict[key];
    if (Array.isArray(node.dict.Kids)) {
      for (const kid of node.dict.Kids) if (isRef(kid)) visit(kid, next, depth + 1);
      return;
    }
    if (out.length >= limit) throw Object.assign(new Error('PDF com páginas demais para a marca d\'água'), { pdfUnsupported: true });
    out.push({ num: ref.ref, gen: (doc.entries.get(ref.ref) || {}).gen || 0, dict: node.dict, inherited: next });
  }
  if (!isDict(root) || !isRef(root.dict.Pages)) throw Object.assign(new Error('PDF sem páginas'), { pdfUnsupported: true });
  visit(root.dict.Pages, {}, 0);
  if (!out.length) throw Object.assign(new Error('PDF sem páginas'), { pdfUnsupported: true });
  return out;
}

module.exports = { listPages };
