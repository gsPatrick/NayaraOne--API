'use strict';

/**
 * Esquemas de evento de webhook prontos para os adapters (M9-D213 3.3): o adapter só importa daqui (guarda de fronteiras da M9-D210).
 * `statusEventSchemas` serve ao evento que informa o status de um recurso do fornecedor: campos críticos tipados e com tamanho máximo, o valor monetário
 * com `additionalProperties:false`, e o status como texto (quem decide se é conhecido é o `mapStatus` do adapter, que leva o desconhecido à fila de erros STATUS_UNMAPPED).
 */
const texto = (maxLength) => ({ type: 'string', minLength: 1, maxLength });

function statusEventSchemas({ version = 'v1', extraProperties = {}, extraRequired = [] } = {}) {
  return {
    '*': {
      [version]: {
        type: 'object',
        required: ['id', 'type', 'resourceId', 'status', ...extraRequired],
        properties: {
          id: texto(160),
          type: texto(80),
          api_version: texto(16),
          resourceId: texto(160),
          status: { type: 'string', pattern: '^[A-Za-z_]{1,40}$' },
          idempotencyKey: texto(160),
          occurredAt: texto(40),
          amount: {
            type: 'object',
            additionalProperties: false,
            required: ['value', 'currency'],
            properties: { value: { type: 'number' }, currency: { type: 'string', enum: ['BRL'] } },
          },
          ...extraProperties,
        },
      },
    },
  };
}

module.exports = { statusEventSchemas, texto };
