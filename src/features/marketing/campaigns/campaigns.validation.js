'use strict';

const { METRICS, CHANNELS } = require('./campaigns.constants');
const { validation } = require('./campaigns.errors');
const { parseAudiences } = require('./audience.validation');
const { parseSteps } = require('./steps.validation');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);
const absent = (value) => value === undefined || value === null;

function text(value, field, max) {
  if (absent(value)) return undefined;
  if (typeof value !== 'string') throw validation(`O campo "${field}" deve ser um texto.`, { field });
  const trimmed = value.trim();
  if (max && trimmed.length > max) throw validation(`O campo "${field}" aceita no máximo ${max} caracteres.`, { field });
  return trimmed;
}

/** Valor monetário/numérico com 2 casas. Número ou texto numérico; qualquer outra coisa: 400. Faixa (maior que zero etc.) não é checada aqui. */
function amount(value, field) {
  if (absent(value)) return undefined;
  const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
  if (!Number.isFinite(n)) throw validation(`O campo "${field}" deve ser um número.`, { field });
  return Math.round(n * 100) / 100;
}

function channels(value) {
  if (absent(value)) return undefined;
  if (!Array.isArray(value) || value.some((c) => typeof c !== 'string')) throw validation('O campo "channels" deve ser uma lista de canais.', { field: 'channels' });
  const list = [...new Set(value.map((c) => c.trim().toUpperCase()))];
  const unknown = list.filter((c) => !CHANNELS.includes(c));
  if (unknown.length > 0) throw validation(`Canal desconhecido: ${unknown.join(', ')}.`, { field: 'channels', unknown });
  return list;
}

/**
 * Lê o corpo de POST /marketing/campaigns. Campo ausente (ou null) = "não informado": ao completar um rascunho o valor guardado
 * permanece. Só valida forma e tipo; as regras de negócio (itens obrigatórios, faixas) ficam no serviço.
 */
function parseBody(raw) {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!body) throw validation('Envie o corpo da campanha em JSON.');
  if (!absent(body.campaignId) && !isUuid(body.campaignId)) throw validation('O campo "campaignId" deve ser um identificador válido.', { field: 'campaignId' });
  if (!absent(body.schedule) && typeof body.schedule !== 'boolean') throw validation('O campo "schedule" deve ser verdadeiro ou falso.', { field: 'schedule' });
  const metric = text(body.objectiveMetric, 'objectiveMetric', 16);
  if (metric !== undefined && !METRICS.includes(metric.toUpperCase())) {
    throw validation(`A métrica do objetivo deve ser uma de: ${METRICS.join(', ')}.`, { field: 'objectiveMetric', allowed: METRICS });
  }
  if (!absent(body.ownerUserId) && !isUuid(body.ownerUserId)) throw validation('O campo "ownerUserId" deve ser um identificador válido.', { field: 'ownerUserId' });
  const fields = {
    code: text(body.code, 'code', 60),
    name: text(body.name, 'name', 200),
    objective: text(body.objective, 'objective'),
    objectiveMetric: metric === undefined ? undefined : metric.toUpperCase(),
    targetValue: amount(body.targetValue, 'targetValue'),
    budgetAmount: amount(body.budgetAmount, 'budgetAmount'),
    budgetJustification: text(body.budgetJustification, 'budgetJustification'),
    channels: channels(body.channels),
    startsAt: text(body.startsAt, 'startsAt'),
    endsAt: text(body.endsAt, 'endsAt'),
    ownerUserId: absent(body.ownerUserId) ? undefined : body.ownerUserId,
  };
  return {
    campaignId: absent(body.campaignId) ? null : body.campaignId,
    schedule: body.schedule === true,
    fields,
    audiences: absent(body.audiences) ? null : parseAudiences(body.audiences),
    steps: absent(body.steps) ? null : parseSteps(body.steps),
  };
}

module.exports = { parseBody, isUuid };
