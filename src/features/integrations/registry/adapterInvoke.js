'use strict';

const AppError = require('../../../utils/AppError');
const { validar } = require('./jsonSchemaLite');
const { requestInvalid, responseInvalid } = require('./adapters.errors');
const { recordError } = require('../errors');

/**
 * invoke — chama uma operação do adapter: valida o pedido contra o schema do port, chama `adapter[op](ctx, request)` e valida a
 * resposta NORMALIZADA ({ externalRequestId, externalResourceId, status }). `raw` NUNCA sai daqui. Status que o adapter não
 * conseguiu mapear (502 INTEGRATION_STATUS_UNMAPPED) vira erro de integração da empresa quando `opts.tenant` é informado, gravado
 * na transação de quem chama (que precisa capturar a recusa e comitar para a linha ficar).
 */
async function invoke(adapter, operation, request, opts = {}) {
  const Port = adapter.constructor;
  const def = Port.operations && Port.operations[operation];
  if (!def || !adapter.capabilities().includes(operation) || typeof adapter[operation] !== 'function') {
    throw AppError.badRequest(`Operação não suportada por este fornecedor: ${operation}.`, 'INTEGRATION_OPERATION_UNSUPPORTED');
  }
  const pedido = validar(def.inputSchema, request ?? {});
  if (pedido.length) throw requestInvalid(operation, pedido);
  let resposta;
  try {
    resposta = await adapter[operation](adapter.ctx, request ?? {});
  } catch (err) {
    if (err && err.code === 'INTEGRATION_STATUS_UNMAPPED' && opts.tenant) {
      await recordError(opts.tenant, {
        providerCode: adapter.providerCode(), source: 'CONTRACT', errorClass: 'VALIDATION', errorCode: 'INTEGRATION_STATUS_UNMAPPED', connectionId: adapter.ctx?.connection?.id || null,
        operation, message: 'O fornecedor devolveu um status que o adaptador não reconhece.',
      }, opts.transaction);
    }
    throw err;
  }
  const normalizada = { externalRequestId: resposta?.externalRequestId ?? null, externalResourceId: resposta?.externalResourceId ?? null, status: resposta?.status };
  const saida = validar(def.outputSchema, normalizada);
  if (saida.length) throw responseInvalid(operation, saida);
  return normalizada;
}

module.exports = { invoke };
