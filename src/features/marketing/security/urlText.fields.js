'use strict';

const { mktUrlNotAllowed } = require('../marketing.errors');
const { findDisallowedUrls, findReviewUrls } = require('./urlText');
const { readUrlConfig } = require('./url.settings');
const { readUrlLimits } = require('./urlText.limits');

/**
 * M9-D414 (reabertura da rodada 4) — varredura única dos campos de texto que chegam ao destinatário ou são gravados para ele: envio direto, definição de automação,
 * template e legenda de vídeo. Cada campo é conferido pelo extrator da M9-D433 (recusa) e pela política de revisão (candidato ambíguo onde não há aprovador).
 * Tetos antes de qualquer extração: por variável, por campo e no total (parâmetros marketing.url.max_chars_*), então um corpo enorme nunca chega ao extrator.
 * Motivos: CAMPO_GRANDE_DEMAIS, TEXTO_GRANDE_DEMAIS e REVISAO_HUMANA_NECESSARIA (além dos de URL_RULES).
 */
const MAX_DEPTH = 8;
const TOO_BIG_FIELD = 'CAMPO_GRANDE_DEMAIS';
const TOO_BIG_TOTAL = 'TEXTO_GRANDE_DEMAIS';
const REVIEW_REQUIRED = 'REVISAO_HUMANA_NECESSARIA';

/** Todo texto de um valor, em qualquer profundidade (array e objeto aninhados; chave de objeto também é lida). Número e booleano viram texto. Devolve [{ field, value, variable }]. */
function leafTexts(value, path, out = [], depth = 0, budget = { left: Infinity }) {
  if (value === null || value === undefined) return out;
  if (budget.left <= 0) { if (!out.tooMany) { out.tooMany = true; out.push({ field: `${path}(itens)`, value: '', variable: true, tooMany: true }); } return out; }
  budget.left -= 1;
  if (depth > MAX_DEPTH) { out.push({ field: `${path}(profundidade)`, value: '', variable: true, deep: true }); return out; }
  if (typeof value === 'string') out.push({ field: path, value, variable: true });
  else if (typeof value === 'number' || typeof value === 'boolean') out.push({ field: path, value: String(value), variable: true });
  else if (Array.isArray(value)) for (let i = 0; i < value.length && !out.tooMany; i += 1) leafTexts(value[i], `${path}[${i}]`, out, depth + 1, budget);
  else if (typeof value === 'object') for (const k of Object.keys(value)) { if (out.tooMany) break; out.push({ field: `${path}.${k}(chave)`, value: k, variable: true }); leafTexts(value[k], `${path}.${k}`, out, depth + 1, budget); }
  return out;
}

/** Campos de texto soltos [{ field, value }] + folhas de variáveis; só o que for texto não vazio entra. */
function collectFields(texts, variables, root = 'variables.', maxItems = Infinity) {
  const fields = [];
  for (const [field, value] of texts) if (typeof value === 'string' && value) fields.push({ field, value, variable: false });
  const budget = { left: maxItems };
  for (const name of Object.keys(variables || {})) { if (fields.tooMany) break; leafTexts(variables[name], `${root}${name}`, fields, 0, budget); }
  return fields;
}

/** Tetos de tamanho. Devolve os motivos [{ field, url, reasons, limit }] dos que passaram do teto (sem extrair nada). */
function sizeProblems(fields, limits) {
  const bad = [];
  let total = 0;
  for (const f of fields) {
    const limit = f.variable ? limits.maxVariable : limits.maxField;
    total += f.value.length;
    if (f.tooMany) bad.push({ field: f.field, url: null, reasons: [TOO_BIG_TOTAL], limit: limits.maxTotal });
    else if (f.deep) bad.push({ field: f.field, url: null, reasons: [TOO_BIG_FIELD], limit: MAX_DEPTH });
    else if (f.value.length > limit) bad.push({ field: f.field, url: null, reasons: [TOO_BIG_FIELD], limit, size: f.value.length });
  }
  if (bad.length === 0 && total > limits.maxTotal) bad.push({ field: '(total)', url: null, reasons: [TOO_BIG_TOTAL], limit: limits.maxTotal, size: total });
  return bad;
}

/**
 * Varre os campos. texts: [[campo, texto]]; variables: objeto de variáveis (qualquer profundidade); ctx: { tenant, transaction, config?, origin?, fieldPrefix?, leafRoot? (prefixo do caminho das variáveis, padrão "variables.") }.
 * Devolve { bad, review }: bad = recusados (URL fora da regra, teto de tamanho); review = candidatos ambíguos (só quando blockReview, viram bad).
 */
async function scanTextFields(texts, variables, ctx) {
  const { tenant, transaction } = ctx;
  const limits = ctx.limits || await readUrlLimits(tenant, transaction);
  const fields = collectFields(texts, variables, ctx.leafRoot, limits.maxTotal);
  const oversize = sizeProblems(fields, limits);
  if (oversize.length > 0) return { bad: oversize, review: [], limits };
  const config = ctx.config || await readUrlConfig(tenant, transaction);
  const bad = [];
  const review = [];
  for (const { field, value } of fields) {
    const name = ctx.fieldPrefix ? `${ctx.fieldPrefix}${field}` : field;
    for (const hit of await findDisallowedUrls(value, { tenant, transaction, config, origin: ctx.origin })) bad.push({ field: name, ...hit });
    for (const url of await findReviewUrls(value, { tenant, transaction, config })) review.push({ field: name, url, reasons: [REVIEW_REQUIRED] });
  }
  return { bad, review, limits };
}

/**
 * Só os tetos de tamanho (sem extrair nada), para o ponto que NÃO recusa candidato ambíguo (o pipeline de conteúdo manda o ambíguo à aprovação humana): variável do pedido
 * de conteúdo, antes de renderizar o template. Lança 422 MKT_URL_NOT_ALLOWED (CAMPO_GRANDE_DEMAIS / TEXTO_GRANDE_DEMAIS), nunca 500.
 */
async function assertTextSizes(texts, variables, ctx) {
  const limits = ctx.limits || await readUrlLimits(ctx.tenant, ctx.transaction);
  const bad = sizeProblems(collectFields(texts, variables, ctx.leafRoot, limits.maxTotal), limits);
  if (bad.length > 0) throw mktUrlNotAllowed({ urls: bad });
  return true;
}

/** Lança 422 MKT_URL_NOT_ALLOWED se algum campo for recusado, passar de teto ou (com blockReview) tiver candidato ambíguo sem aprovador. */
async function assertTextFieldsSafe(texts, variables, ctx) {
  const { bad, review, limits } = await scanTextFields(texts, variables, ctx);
  const all = limits.blockReview ? [...bad, ...review] : bad;
  if (all.length > 0) throw mktUrlNotAllowed({ urls: all });
  return { review };
}

module.exports = { leafTexts, collectFields, sizeProblems, scanTextFields, assertTextFieldsSafe, assertTextSizes, TOO_BIG_FIELD, TOO_BIG_TOTAL, REVIEW_REQUIRED };
