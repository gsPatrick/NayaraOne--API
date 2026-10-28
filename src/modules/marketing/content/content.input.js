'use strict';

const { contentInvalid } = require('./pipeline.errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTENT_TYPES = Object.freeze([
  'NEW_PROPERTY', 'PRICE_REDUCTION', 'SOLD_RENTED', 'NAYARA_CONSTRUCTION', 'INSTITUTIONAL', 'EDUCATIONAL_BLOG',
  'POST_SALE', 'BIRTHDAY_RELATIONSHIP', 'SEGMENTED_CAMPAIGN', 'VIDEO_REEL',
]);
const CREATE_FIELDS = ['contentItemId', 'type', 'title', 'sourceEntityType', 'sourceEntityId', 'texto', 'templateId', 'templateCode', 'variables', 'campaignId'];
const SCHEDULE_FIELDS = ['channels', 'when'];
const APPROVE_FIELDS = ['decision', 'reason'];

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

function assertKnownFields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw contentInvalid('Corpo da requisição inválido.');
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) throw contentInvalid(`Dados inválidos: campo(s) desconhecido(s): ${unknown.join(', ')}.`, { unknown });
}

function optionalString(body, field, max) {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw contentInvalid(`Dados inválidos: ${field}.`, { field });
  return v.trim();
}

/** Corpo de POST /marketing/content: cria o conteúdo ou, com contentItemId, retoma/revisa o existente. */
function parseCreateBody(body) {
  assertKnownFields(body, CREATE_FIELDS);
  const out = {
    contentItemId: optionalString(body, 'contentItemId', 40),
    type: optionalString(body, 'type', 40),
    title: optionalString(body, 'title', 300),
    sourceEntityType: optionalString(body, 'sourceEntityType', 80),
    sourceEntityId: optionalString(body, 'sourceEntityId', 40),
    texto: body.texto === undefined || body.texto === null ? undefined : String(body.texto),
    templateId: optionalString(body, 'templateId', 40),
    templateCode: optionalString(body, 'templateCode', 80),
    campaignId: optionalString(body, 'campaignId', 40),
    variables: body.variables,
  };
  if (body.texto !== undefined && body.texto !== null && (typeof body.texto !== 'string' || !body.texto.trim() || body.texto.length > 20000)) {
    throw contentInvalid('Dados inválidos: texto.', { field: 'texto' });
  }
  if (out.variables !== undefined && (out.variables === null || typeof out.variables !== 'object' || Array.isArray(out.variables))) {
    throw contentInvalid('Dados inválidos: variables.', { field: 'variables' });
  }
  for (const f of ['contentItemId', 'sourceEntityId', 'templateId', 'campaignId']) {
    if (out[f] !== undefined && !isUuid(out[f])) throw contentInvalid(`Dados inválidos: ${f}.`, { field: f });
  }
  if (!out.contentItemId) {
    if (!CONTENT_TYPES.includes(out.type)) throw contentInvalid('Informe o tipo de conteúdo.', { field: 'type', allowed: CONTENT_TYPES });
    if (!!out.sourceEntityType !== !!out.sourceEntityId) throw contentInvalid('Informe o tipo e o id da fonte juntos.', { field: 'sourceEntityId' });
    if (!out.title && !out.sourceEntityType) throw contentInvalid('Informe o título do conteúdo.', { field: 'title' });
  }
  return out;
}

function parseScheduleBody(body) {
  assertKnownFields(body, SCHEDULE_FIELDS);
  return { channels: body.channels, when: body.when };
}

function parseApproveBody(body) {
  assertKnownFields(body, APPROVE_FIELDS);
  return { decision: body.decision, reason: body.reason };
}

module.exports = { CONTENT_TYPES, isUuid, parseCreateBody, parseScheduleBody, parseApproveBody };
