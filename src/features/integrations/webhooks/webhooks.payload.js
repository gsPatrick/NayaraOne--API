'use strict';

const crypto = require('crypto');

/**
 * Leitura do corpo SÓ DEPOIS da assinatura válida (M9-D211 passo 6): JSON.parse protegido, objeto na raiz, identificador do evento e tipo.
 * Os limites de estrutura (profundidade, chaves), o esquema mínimo e o replay são da M9-D213 e entram em `payloadChecks` sem mudar este módulo.
 * Motivos que levam o evento à fila morta (dead_letter_reason): INVALID_JSON, STRUCTURE_LIMIT, SCHEMA_INVALID, EVENT_ID_MISSING.
 */
const ID_KEYS = ['id', 'event_id', 'eventId', 'externalEventId', 'external_event_id'];
const TYPE_KEYS = ['type', 'event_type', 'eventType'];
const TENANT_KEYS = ['company_id', 'companyId', 'group_id', 'groupId'];
const ID_HEADERS = ['x-event-id', 'x-webhook-id'];
const TYPE_HEADER = 'x-event-type';

const asId = (v) => (typeof v === 'string' && v.trim() ? v.trim() : (typeof v === 'number' && Number.isFinite(v) ? String(v) : ''));
const first = (obj, keys) => keys.map((k) => asId(obj[k])).find(Boolean) || '';
const header = (headers, nome) => { const v = headers ? headers[nome] : undefined; return asId(Array.isArray(v) ? v[0] : v); };

/** Verificações extras sobre o objeto lido; cada uma devolve null ou { reason, detail }. A M9-D213 acrescenta as suas. */
const payloadChecks = [];

function parseEvent(rawBody, headers, verified = {}) {
  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { ok: false, reason: 'INVALID_JSON', detail: 'O corpo não é um JSON válido.' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'SCHEMA_INVALID', detail: 'A raiz do evento precisa ser um objeto.' };
  for (const check of payloadChecks) {
    const problema = check(body, { headers, verified });
    if (problema) return { ok: false, body, ...problema };
  }
  const eventId = asId(verified.eventId) || first(body, ID_KEYS) || ID_HEADERS.map((h) => header(headers, h)).find(Boolean) || '';
  if (!eventId || eventId.length > 160) return { ok: false, body, reason: 'EVENT_ID_MISSING', detail: 'O evento não traz um identificador externo.' };
  const eventType = first(body, TYPE_KEYS) || header(headers, TYPE_HEADER) || null;
  return { ok: true, body, eventId, eventType };
}

/** Corpo que cita OUTRA empresa ou grupo que não os da connection do canal: o tenant vem sempre da connection (M9-D211 6). */
function foreignTenant(body, conn) {
  const citado = (chaves, esperado) => chaves.map((k) => asId(body[k])).filter(Boolean).some((v) => v.toLowerCase() !== String(esperado).toLowerCase());
  return citado(['company_id', 'companyId'], conn.companyId) || citado(['group_id', 'groupId'], conn.groupId);
}

/** Id do evento rejeitado: sha256(fornecedor:instante:hash do corpo), para o mesmo corpo recebido em instantes diferentes não colidir. */
const rejectedEventId = (provider, bodyHash, now = new Date()) => crypto.createHash('sha256').update(`${provider}:${now.toISOString()}:${bodyHash}`).digest('hex');

module.exports = { parseEvent, foreignTenant, rejectedEventId, payloadChecks, TENANT_KEYS };
