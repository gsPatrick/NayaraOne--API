'use strict';

const crypto = require('node:crypto');

/** JSON canônico: chaves em ordem alfabética em qualquer profundidade, sem espaços; undefined some. Mesma entrada, mesmo hash. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** Hash do conteúdo do template: tudo que dá a cara da marca (texto, variáveis, tokens, canal, referência oficial) e a versão. */
function computeTemplateContentHash({ code, versionNo, kind, channel, body, variables, brandTokens, officialTemplateRef }) {
  return sha256(canonicalJson({
    code, versionNo, kind, channel: channel || null, body, variables: variables || [], brandTokens: brandTokens || {},
    officialTemplateRef: officialTemplateRef || null,
  }));
}

/**
 * approved_hash (Caderno §14/§16): SHA-256 de content_hash + template_id + template.version_no + template.content_hash.
 * Conteúdo sem template entra com os três campos do template vazios. Campos separados por "|" (nenhum contém esse caractere).
 */
function computeApprovedHash({ contentHash, templateId, templateVersionNo, templateContentHash }) {
  return sha256([contentHash, templateId || '', templateVersionNo === null || templateVersionNo === undefined ? '' : String(templateVersionNo), templateContentHash || ''].join('|'));
}

module.exports = { canonicalJson, sha256, computeTemplateContentHash, computeApprovedHash };
