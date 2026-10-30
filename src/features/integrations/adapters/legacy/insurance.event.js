'use strict';

/**
 * Evento de status da apólice enviado pela seguradora (M9-D238 3.4: "seguradora com webhook de status: pela inbox"). Formato do laboratório e dos adapters reais que têm webhook:
 * { id, type: 'policy.status', policy: { id }, status }. O evento interno normalizado leva só o identificador externo da apólice e o status (vão ao outbox); o tratador de Compras
 * (procurement/insurance/insurance.webhook.js) aplica o status à apólice e o dispatch ligado é resolvido pelo worker da caixa de entrada.
 */
const SCHEMA_EVENTO = Object.freeze({
  type: 'object',
  required: ['id', 'type', 'policy', 'status'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 160 },
    type: { type: 'string', enum: ['policy.status'] },
    api_version: { type: 'string', minLength: 1, maxLength: 16 },
    policy: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 160 }, number: { type: 'string', maxLength: 128 } } },
    status: { type: 'string', pattern: '^[A-Za-z_]{1,24}$' },
  },
});

function toInternalEvent(payload) {
  const policy = (payload && payload.policy) || {};
  return {
    eventType: 'integration.insurance.policy_status',
    resourceRef: policy.id || null,
    externalStatus: payload && payload.status ? String(payload.status).toUpperCase() : null,
    idempotencyKey: null,
    data: { kind: 'POLICY_STATUS', externalPolicyId: policy.id || null },
    private: { policyNumber: policy.number || null },
  };
}

module.exports = { SCHEMA_EVENTO, toInternalEvent };
