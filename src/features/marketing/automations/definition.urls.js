'use strict';

const security = require('../security');
const { mktUrlNotAllowed } = require('../marketing.errors');

/**
 * M9-D414 (reabertura L-5) / M9-D433 — o texto que uma ação da automação vai usar passa pela regra de URL externa já na definição (rascunho e publicação): texto, assunto,
 * pré-cabeçalho, título, corpo, descrição e toda folha das demais chaves da ação (variáveis, cta, listas), e o `portalUrl` do envio. Aqui alguém digita o texto, então vale a regra completa (com DNS e
 * redirecionamento, se o parâmetro estiver ligado). Reprovada = 422 MKT_URL_NOT_ALLOWED com a ação e o campo.
 */
const TEXT_FIELDS = Object.freeze(['text', 'texto', 'subject', 'preheader', 'title', 'body', 'description', 'message']); // campos de texto livre (teto de campo)
const SKIPPED_KEYS = new Set(['actionType', 'portalUrl', 'channel', 'purpose', 'assignee', 'priority', 'stage', 'status', 'kind']); // enums do catálogo; o portalUrl tem validação própria abaixo
const CONFIG_OBJECTS = new Set(['cadence']); // objetos de configuração da ação (ex.: cadence.code é código de parâmetro): nunca chegam ao destinatário. Dentro de variables, cta e demais chaves NENHUMA chave é poupada
const STRUCTURAL_KEY = /(Param|Provider|Resolver|Key|Code|Ref|Filter|Expander|Ids?)$/; // referências a parâmetro, porta ou identificador (ex.: dueInMinutesParam: "marketing.lead.novo.prazo"): não chegam ao destinatário

/** Separa a ação em campos de texto livre e o resto (variáveis, cta, botões, listas: toda folha, em qualquer profundidade, é varrida com o teto de variável). */
function splitAction(action) {
  const texts = [];
  const rest = {};
  for (const [k, v] of Object.entries(action)) {
    if (SKIPPED_KEYS.has(k) || CONFIG_OBJECTS.has(k) || STRUCTURAL_KEY.test(k)) continue;
    if (TEXT_FIELDS.includes(k) && typeof v === 'string') texts.push([k, v]);
    else rest[k] = v;
  }
  return { texts, rest };
}

async function assertActionUrls(def, tenant, transaction) {
  const config = await security.readUrlConfig(tenant, transaction);
  const limits = await security.readUrlLimits(tenant, transaction);
  const ctx = { tenant, transaction, config };
  const bad = [];
  const review = [];
  const actions = Array.isArray(def.actions) ? def.actions : [];
  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i] && typeof actions[i] === 'object' ? actions[i] : {};
    const { texts, rest } = splitAction(action);
    const scan = await security.scanTextFields(texts, rest, { ...ctx, limits, fieldPrefix: `actions[${i}].`, leafRoot: '' });
    bad.push(...scan.bad);
    review.push(...scan.review);
    if (typeof action.portalUrl === 'string' && action.portalUrl) {
      const out = await security.validateExternalUrl(action.portalUrl, ctx);
      if (!out.ok) bad.push({ field: `actions[${i}].portalUrl`, url: action.portalUrl, reasons: out.reasons });
    }
  }
  const all = limits.blockReview ? [...bad, ...review] : bad;
  if (all.length > 0) throw mktUrlNotAllowed({ urls: all });
}

module.exports = { assertActionUrls };
