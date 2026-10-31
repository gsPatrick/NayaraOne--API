'use strict';

const security = require('../../../security');
const { mktUrlNotAllowed } = require('../../../marketing.errors');

/**
 * M9-D414 (reabertura L-5) / M9-D433 — o que o destinatário lê passa pela regra de URL externa: o texto final (já com as variáveis do template), o assunto, o pré-cabeçalho e
 * cada variável de texto enviada ao canal. O envio roda por mensagem, então vale a regra estática (https, allowlist, encurtador, credencial, IP), sem DNS por mensagem
 * (DI-D433-3); a regra completa, com DNS e redirecionamento, vale quando alguém digita o texto (definição da automação e template). Reprovada = 422 MKT_URL_NOT_ALLOWED.
 */
/** Todo texto de uma variável, em qualquer profundidade (array e objeto aninhados; chaves de objeto também são lidas), com o caminho para a resposta; número e booleano viram texto. */
function leafTexts(value, path, out = [], depth = 0) {
  if (depth > 8 || value === null || value === undefined) return out;
  if (typeof value === 'string') out.push([path, value]);
  else if (typeof value === 'number' || typeof value === 'boolean') out.push([path, String(value)]);
  else if (Array.isArray(value)) value.forEach((item, i) => leafTexts(item, `${path}[${i}]`, out, depth + 1));
  else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push([`${path}.${k}(chave)`, k]); leafTexts(v, `${path}.${k}`, out, depth + 1); }
  return out;
}

async function assertMessageTexts(input, text, tenant, transaction) {
  const fields = [['text', text], ['subject', input.subject], ['preheader', input.preheader]];
  for (const [name, value] of Object.entries(input.variables || {})) fields.push(...leafTexts(value, `variables.${name}`)); // N-6: array e objeto também
  const config = await security.readUrlConfig(tenant, transaction);
  const bad = [];
  for (const [field, value] of fields) {
    if (typeof value !== 'string' || !value) continue;
    for (const hit of await security.findDisallowedUrls(value, { tenant, transaction, config, origin: 'SYSTEM' })) bad.push({ field, ...hit });
  }
  if (bad.length > 0) throw mktUrlNotAllowed({ urls: bad });
}

module.exports = { assertMessageTexts };
