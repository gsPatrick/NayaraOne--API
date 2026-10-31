'use strict';

const security = require('../security');
const { mktUrlNotAllowed } = require('../marketing.errors');

/**
 * M9-D414 (reabertura L-5) / M9-D433 — o texto que uma ação da automação vai usar passa pela regra de URL externa já na definição (rascunho e publicação): texto, assunto,
 * pré-cabeçalho, título, corpo, descrição e variáveis de texto das ações, e o `portalUrl` do envio. Aqui alguém digita o texto, então vale a regra completa (com DNS e
 * redirecionamento, se o parâmetro estiver ligado). Reprovada = 422 MKT_URL_NOT_ALLOWED com a ação e o campo.
 */
const TEXT_FIELDS = Object.freeze(['text', 'texto', 'subject', 'preheader', 'title', 'body', 'description', 'message']);

async function assertActionUrls(def, tenant, transaction) {
  const config = await security.readUrlConfig(tenant, transaction);
  const ctx = { tenant, transaction, config };
  const bad = [];
  const actions = Array.isArray(def.actions) ? def.actions : [];
  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i] || {};
    const fields = TEXT_FIELDS.map((f) => [f, action[f]]);
    if (action.variables && typeof action.variables === 'object') for (const [k, v] of Object.entries(action.variables)) fields.push([`variables.${k}`, v]);
    for (const [field, value] of fields) {
      if (typeof value !== 'string' || !value) continue;
      for (const hit of await security.findDisallowedUrls(value, ctx)) bad.push({ field: `actions[${i}].${field}`, ...hit });
    }
    if (typeof action.portalUrl === 'string' && action.portalUrl) {
      const out = await security.validateExternalUrl(action.portalUrl, ctx);
      if (!out.ok) bad.push({ field: `actions[${i}].portalUrl`, url: action.portalUrl, reasons: out.reasons });
    }
  }
  if (bad.length > 0) throw mktUrlNotAllowed({ urls: bad });
}

module.exports = { assertActionUrls };
