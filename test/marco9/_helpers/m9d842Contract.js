'use strict';

// Apoio dos testes M9-D842 (não é teste, sem banco): contrato pequeno em memória e respostas reais simuladas para provar cada detecção do contract test.
const ERROR = { $ref: '#/components/schemas/ErrorEnvelope' };
const jsonBody = (schema) => ({ content: { 'application/json': { schema } } });
const withCorrelation = { headers: { 'X-Correlation-Id': { required: true, schema: { type: 'string' } } } };

function contract() {
  return {
    openapi: '3.0.3',
    info: { title: 'Teste', version: '1.0.0' },
    paths: {
      '/tasks/{id}': {
        get: {
          responses: {
            200: {
              description: 'ok', ...withCorrelation,
              ...jsonBody({
                type: 'object', required: ['success', 'data'],
                properties: { success: { type: 'boolean' }, data: { type: 'object', required: ['id', 'dueAt', 'status'], properties: { id: { type: 'string', format: 'uuid' }, dueAt: { type: 'string', format: 'date-time' }, status: { type: 'string', enum: ['OPEN', 'DONE'] }, note: { type: 'string', nullable: true } } } },
              }),
            },
            404: { description: 'não achou', 'x-error-code': 'GOV_NOT_FOUND', ...jsonBody(ERROR) },
          },
        },
      },
      '/ping': { get: { responses: { 200: { description: 'ok', ...jsonBody({ type: 'object' }) } } } },
    },
    components: {
      schemas: {
        ErrorEnvelope: {
          type: 'object', required: ['success', 'error'],
          properties: { success: { type: 'boolean' }, error: { type: 'object', required: ['code', 'message', 'traceId'], properties: { code: { type: 'string' }, message: { type: 'string' }, details: { nullable: true }, traceId: { type: 'string' } } } },
        },
      },
    },
  };
}

const UUID = '3f1f1c1e-6c0a-4d6c-9a52-2f2f0d3c8e11';
const DATA = { id: UUID, dueAt: '2026-11-05T15:00:00.000Z', status: 'OPEN', note: null };
const CODES = new Set(['GOV_NOT_FOUND', 'PERMISSION_DENIED', 'MISSING_ACCESS_TOKEN']);

/** Resposta real simulada. `over` troca status, cabeçalhos, tipo ou corpo. */
function response(over = {}) {
  const status = over.status || 200;
  return {
    status, contentType: 'application/json; charset=utf-8', headers: { 'x-correlation-id': 'corr-1' },
    json: status < 300 ? { success: true, data: DATA } : { success: false, error: { code: 'GOV_NOT_FOUND', message: 'Não encontrado.', traceId: 'corr-1' } },
    text: 'corpo', ...over,
  };
}

const operationOf = (doc, path = '/tasks/{id}', method = 'get') => ({ method: method.toUpperCase(), path, operation: doc.paths[path][method], components: doc.components, codes: CODES });

module.exports = { contract, response, operationOf, DATA, UUID, CODES };
