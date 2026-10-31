'use strict';

const security = require('../../../security');
const { mktUrlNotAllowed } = require('../../../marketing.errors');

/**
 * M9-D414 (reabertura L-5) / M9-D433 — o que o destinatário lê passa pela regra de URL externa: o texto final (já com as variáveis do template), o assunto, o pré-cabeçalho e
 * cada variável de texto enviada ao canal. O envio roda por mensagem, então vale a regra estática (https, allowlist, encurtador, credencial, IP), sem DNS por mensagem
 * (DI-D433-3); a regra completa, com DNS e redirecionamento, vale quando alguém digita o texto (definição da automação e template). Reprovada = 422 MKT_URL_NOT_ALLOWED.
 */
async function assertMessageTexts(input, text, tenant, transaction) {
  const fields = [['text', text], ['subject', input.subject], ['preheader', input.preheader]];
  for (const [name, value] of Object.entries(input.variables || {})) if (typeof value === 'string') fields.push([`variables.${name}`, value]);
  const config = await security.readUrlConfig(tenant, transaction);
  const bad = [];
  for (const [field, value] of fields) {
    if (typeof value !== 'string' || !value) continue;
    for (const hit of await security.findDisallowedUrls(value, { tenant, transaction, config, origin: 'SYSTEM' })) bad.push({ field, ...hit });
  }
  if (bad.length > 0) throw mktUrlNotAllowed({ urls: bad });
}

module.exports = { assertMessageTexts };
