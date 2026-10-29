'use strict';

/**
 * M9-D693 (3.3) — esquema da saída da NAY: JSON `{ itens: [...] }`. Saída que não é JSON ou não tem `itens` é recusada por inteiro (422
 * ANALYTICS_BRIEF_SCHEMA_INVALID, nada é gravado como briefing). Item com forma errada, sem fonte ou fora da lista pedida é DESCARTADO com o
 * motivo, sem derrubar os demais. Campos obrigatórios em todo item: fato, fonte e freshness (a freshness é preenchida pelo servidor a partir da fonte).
 */
const AppError = require('../../../utils/AppError');

const SCHEMA_MSG = 'Resposta da NAY fora do formato esperado.';
const TIPOS = new Set(['EXCECAO', 'DESTAQUE']);
const AFIRMACOES = new Set(['FATO', 'CAUSA']);
const OPTIONAL_TEXT = ['variacao', 'incerteza', 'acaoSugerida'];

const schemaInvalid = () => AppError.unprocessable(SCHEMA_MSG, 'ANALYTICS_BRIEF_SCHEMA_INVALID');

/** Texto da resposta -> { itens: object[] }; qualquer desvio do formato é 422. */
function parseModelOutput(answer) {
  const text = String(answer ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let data;
  try { data = JSON.parse(text); } catch (err) { throw schemaInvalid(); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.itens)) throw schemaInvalid();
  return data;
}

const isText = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Motivo para descartar o item, ou null se a forma está certa. `candidate` é o candidato do servidor com o mesmo refId (null se o refId
 * não foi pedido). A fonte do item precisa apontar para métricas do candidato; o modelo não cria fonte.
 */
function shapeIssue(item, candidate) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return 'Item fora do formato.';
  if (!isText(item.refId) || !candidate) return 'Item que não corresponde a nenhum item pedido.';
  if (!TIPOS.has(item.tipo) || item.tipo !== candidate.tipo) return 'Tipo do item diferente do pedido.';
  if (!isText(item.fato)) return 'Item sem o fato.';
  for (const f of OPTIONAL_TEXT) if (item[f] !== undefined && item[f] !== null && typeof item[f] !== 'string') return `Campo "${f}" não é texto.`;
  if (item.tipoAfirmacao !== undefined && !AFIRMACOES.has(item.tipoAfirmacao)) return 'Marcador tipoAfirmacao inválido.';
  if (item.fonteCausa !== undefined && !(Array.isArray(item.fonteCausa) && item.fonteCausa.every((x) => typeof x === 'string'))) return 'Campo fonteCausa inválido.';
  const refs = Array.isArray(item.fonte) ? item.fonte.map((f) => f && f.metricCode) : [];
  const allowed = new Set([candidate.metricCode]);
  if (!refs.length || !candidate.fonte.length || !refs.every((code) => allowed.has(code))) return 'Item sem fonte válida: a fonte precisa ser o indicador do item pedido.';
  return null;
}

module.exports = { parseModelOutput, shapeIssue, schemaInvalid, SCHEMA_MSG };
