'use strict';

const { KnowledgeEntry } = require('../../../models');

/**
 * Fatos declarados nas fontes do RAG (M9-D024), a base para dizer que duas fontes divergem. Só se compara o que tem CHAVE de assunto:
 *  - conhecimento homologado (M9-D008): a chave é o `fact_key` da entrada e o valor, o `fact_value_json`;
 *  - trecho de documento ou de link que declare o fato numa linha própria `<marcador>: <chave> = <valor>` (marcador do parâmetro
 *    `ia.rag.conflito.marcador`, padrão "Fato"), por exemplo `Fato: prazo_entrega_dias = 60`.
 * Números sem chave nunca são comparados (falso conflito).
 */
const KEY_RE = '[a-z][a-z0-9_.:-]{2,127}';
const NUMBER = /^[-+]?\d+(?:[.,]\d+)?\s*%?$/;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Valor comparável: minúsculas, espaços únicos, sem ponto final; número com vírgula ou zeros à direita vira o mesmo número ("7,0 %" = "7%"). */
function normalizeValue(raw) {
  const text = String(raw === null || raw === undefined ? '' : raw).trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.;]+$/, '');
  if (!NUMBER.test(text)) return text;
  const pct = text.endsWith('%') ? '%' : '';
  let num = text.replace('%', '').replace(/\s/g, '').replace(',', '.');
  if (num.includes('.')) num = num.replace(/0+$/, '').replace(/\.$/, '');
  return `${num.replace(/^\+/, '')}${pct}`;
}

/** Fatos declarados em um trecho: [{ key, raw, value }]. */
function declaredFacts(text, marker) {
  if (!text || !marker) return [];
  const re = new RegExp(`^[ \\t>*-]*${escapeRe(marker)}[ \\t]*:[ \\t]*(${KEY_RE})[ \\t]*=[ \\t]*(.+?)[ \\t]*$`, 'gimu');
  const out = [];
  for (const m of String(text).matchAll(re)) out.push({ key: m[1].toLowerCase(), raw: m[2].trim().replace(/[.;]+$/, ''), value: normalizeValue(m[2]) });
  return out;
}

/** Texto do valor de uma entrada: escalar é ele mesmo; objeto de uma só chave vale o conteúdo dela; o resto, o JSON de chaves ordenadas. */
function entryValueText(json) {
  if (json === null || json === undefined) return '';
  if (typeof json !== 'object') return String(json);
  if (Array.isArray(json)) return JSON.stringify(json.map((v) => (typeof v === 'object' ? sorted(v) : v)));
  const keys = Object.keys(json);
  return keys.length === 1 ? entryValueText(json[keys[0]]) : JSON.stringify(sorted(json));
}

function sorted(v) {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]));
  return v;
}

/** Fato de uma entrada de conhecimento (id da empresa da sessão); null se não existir. */
async function knowledgeFact(ctx, sourceId, transaction) {
  const entry = await KnowledgeEntry.findOne({ where: { id: sourceId, companyId: ctx.companyId }, transaction });
  if (!entry) return null;
  const raw = entryValueText(entry.factValueJson);
  return { key: String(entry.factKey).toLowerCase(), raw, value: normalizeValue(raw), title: entry.title, version: entry.version };
}

module.exports = { declaredFacts, knowledgeFact, normalizeValue, entryValueText };
