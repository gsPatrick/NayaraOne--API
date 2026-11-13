'use strict';

const { TEMPLATE_CHANNELS, TEMPLATE_KINDS, TEMPLATE_STATUSES } = require('./template.constants');
const { invalidInput } = require('./template.errors');
const { normalizeVariableDefs } = require('./template.variables');
const { normalizeBrandTokens } = require('./template.brandTokens');
const { assertKnownBodyFields } = require('../marketing.body');

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_BODY = 20000;
const MAX_REF = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

/** Valida o corpo do POST /marketing/templates. `inherited` traz tipo e canal da última versão do mesmo código (se houver). */
function parseCreateInput(input, inherited) {
  const src = input && typeof input === 'object' ? input : {};
  assertKnownBodyFields(src, ['code', 'kind', 'channel', 'body', 'variables', 'brandTokens', 'officialTemplateRef']); // M9-D435
  const code = typeof src.code === 'string' ? src.code.trim() : '';
  if (!CODE_RE.test(code)) throw invalidInput('Informe o código do template (letras, números, ponto, hífen e sublinhado, até 80 caracteres).');
  const kind = src.kind === undefined && inherited ? inherited.kind : src.kind;
  if (!TEMPLATE_KINDS.includes(kind)) throw invalidInput(`O tipo do template deve ser um de: ${TEMPLATE_KINDS.join(', ')}.`);
  const channel = src.channel === undefined ? (inherited ? inherited.channel : null) : src.channel;
  if (channel !== null && !TEMPLATE_CHANNELS.includes(channel)) throw invalidInput(`O canal do template deve ser um de: ${TEMPLATE_CHANNELS.join(', ')}.`);
  if (typeof src.body !== 'string' || !src.body.trim() || src.body.length > MAX_BODY) throw invalidInput(`Informe o corpo do template (até ${MAX_BODY} caracteres).`);
  const ref = src.officialTemplateRef === undefined || src.officialTemplateRef === null ? null : src.officialTemplateRef;
  if (ref !== null && (typeof ref !== 'string' || !ref.trim() || ref.length > MAX_REF)) throw invalidInput(`A referência do template oficial deve ter até ${MAX_REF} caracteres.`);
  return {
    code, kind, channel, body: src.body,
    variables: normalizeVariableDefs(src.variables),
    brandTokens: normalizeBrandTokens(src.brandTokens),
    officialTemplateRef: ref === null ? null : ref.trim(),
  };
}

/** Filtros e paginação do GET /marketing/templates. */
function parseListFilters(raw, limits = { standard: 50, max: 200 }) {
  const f = raw || {};
  if (f.status && !TEMPLATE_STATUSES.includes(f.status)) throw invalidInput(`O status deve ser um de: ${TEMPLATE_STATUSES.join(', ')}.`);
  if (f.channel && !TEMPLATE_CHANNELS.includes(f.channel)) throw invalidInput(`O canal deve ser um de: ${TEMPLATE_CHANNELS.join(', ')}.`);
  const page = f.page === undefined ? 1 : Number(f.page);
  const requested = f.pageSize === undefined ? limits.standard : Number(f.pageSize);
  if (!Number.isSafeInteger(page) || page < 1) throw invalidInput('A página deve ser um inteiro maior que zero.');
  if (!Number.isSafeInteger(requested) || requested < 1) throw invalidInput('O tamanho da página deve ser um inteiro maior que zero.');
  const pageSize = Math.min(requested, limits.max); // como a lista de publicações: acima do máximo vale o máximo
  return { code: f.code || null, status: f.status || null, channel: f.channel || null, page, pageSize };
}

module.exports = { parseCreateInput, parseListFilters, isUuid };
