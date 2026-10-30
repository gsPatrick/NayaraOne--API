'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { sequelize, IntegrationDispatch } = require('../../../models');
const AppError = require('../../../utils/AppError');
const dispatchService = require('../../integrations/dispatch/enqueue/dispatch.service');
const { transitionDispatch } = require('../../integrations/dispatch/dispatch.transition');
const { confirmDispatch } = require('../../integrations/dispatch/worker/worker.confirm');
const { processClaimed } = require('../../integrations/dispatch/worker/worker.process');
const { registerCallObserver } = require('../../integrations/dispatch/worker/worker.hooks');
const adapterRegistry = require('../../integrations/registry/adapterRegistry');
const { invoke } = require('../../integrations/registry/adapterInvoke');
const E = require('./insurance.errors');
const { ensureInsuranceConnection } = require('./insurance.connection');

const OPERATIONS = ['quote', 'propose', 'submitClaim'];
const AGGREGATES = ['InsurancePolicy', 'InsuranceClaim'];
const REMEMBER_MAX = 500;
const RESPONSES = new Map();
const ERRORS = new Map();
const remember = (map, key, value) => { if (map.size >= REMEMBER_MAX) map.delete(map.keys().next().value); map.set(key, value); };

// O worker devolve ao domínio só o resultado normalizado; a regra de Compras precisa do prêmio, da cobertura e do número da apólice (que vêm na resposta da seguradora) e do erro,
// que o observador do worker anota por envio, em memória, até quem pediu ler (mesmo desenho do Correspondente, M9-D240).
registerCallObserver(({ dispatch, error, response }) => {
  if (!AGGREGATES.includes(dispatch.aggregateType) || !OPERATIONS.includes(dispatch.operation)) return;
  if (error) remember(ERRORS, dispatch.id, error);
  else if (response) remember(RESPONSES, dispatch.id, response);
});

const findDispatch = (ctx, id, transaction) => IntegrationDispatch.findOne({ where: { id, companyId: ctx.companyId }, transaction });
const NOT_SENT = ['CANCELLED', 'FAILED'];

/**
 * A chave do pedido com nova tentativa: se os envios anteriores com a chave-base foram recusados por inteiro (CANCELLED ou FAILED: nada chegou à seguradora), o próximo usa a
 * chave com sufixo, para o pedido não ficar preso ao envio cancelado. Incerto, enviado e confirmado mantêm a chave (repetir devolve o mesmo envio, nunca duplica).
 */
async function retryKey(ctx, { base, operation, aggregateType, aggregateId }, transaction) {
  const falhas = await IntegrationDispatch.count({ where: { companyId: ctx.companyId, operation, aggregateType, aggregateId, idempotencyKey: { [Op.like]: `${base}%` }, status: NOT_SENT }, transaction });
  return falhas === 0 ? base : `${base}:r${falhas}`;
}

/** Chave da proposta de uma apólice: `insurance-policy:{id}` (livro e fluxo antigo), com sufixo só depois de uma recusa por inteiro. */
const proposalKey = (ctx, policyId, transaction) => retryKey(ctx, { base: `insurance-policy:${policyId}`, operation: 'propose', aggregateType: 'InsurancePolicy', aggregateId: policyId }, transaction);

/** A resposta de um envio já feito que o processo não guardou (repetição do mesmo pedido, ou outro processo): consulta a apólice pelo contrato do port. */
async function fetchFromProvider(ctx, dispatch, connection, transaction) {
  const adapter = await adapterRegistry.resolve(connection, ctx, transaction);
  if (!adapter.capabilities().includes('getPolicy') || !dispatch.externalResourceId) return { externalResourceId: dispatch.externalResourceId, status: dispatch.externalStatus, policy: {} };
  const normalizada = await invoke(adapter, 'getPolicy', { externalResourceId: dispatch.externalResourceId }, { tenant: ctx, transaction, meta: { transaction } });
  return { ...normalizada, policy: {} };
}

/** Confirma o envio da proposta quando a seguradora já informa o status final da apólice (consulta de status); sem resposta conclusiva o envio segue SUBMITTED até o webhook. Nunca derruba o pedido. */
async function tryConfirmByStatus(ctx, dispatch, connection, transaction) {
  try {
    await sequelize.transaction({ transaction }, async (savepoint) => {
      const adapter = await adapterRegistry.resolve(connection, ctx, savepoint);
      if (!adapter.capabilities().includes('getStatus') || !dispatch.externalResourceId) return;
      const r = await invoke(adapter, 'getStatus', { externalResourceId: dispatch.externalResourceId }, { tenant: ctx, transaction: savepoint, meta: { transaction: savepoint } });
      if (['ACTIVE', 'ISSUED', 'APPROVED'].includes(String(r.status).toUpperCase())) await confirmDispatch(ctx, dispatch.id, { source: 'STATUS_QUERY', status: r.status, externalResourceId: dispatch.externalResourceId }, savepoint);
    });
  } catch { /* a consulta de status é um reforço: o webhook assinado também confirma */ }
}

/**
 * callInsurer — o pedido à seguradora pelo Dispatch Service (M9-D238 3.5): `enqueue` com o conteúdo minimizado (finalidade e hash na linha de integration.dispatches) e a chamada
 * feita pelo worker de envios, na hora (a pessoa espera o prêmio ou o número da apólice). Proposta e sinistro (DANGEROUS) nunca repetem às cegas: a resposta incerta NÃO desfaz o pedido
 * (o envio precisa continuar UNKNOWN, gravado, para a reconciliação pela chave): devolve { uncertain: true } e o chamador responde 202. Devolve { dispatch, response, source, connection };
 * `source` é 'MANUAL' quando a seguradora não tem API (o resultado vem por tarefa).
 * `args`: ctx, policy, operation (quote, propose ou submitClaim), domainObject, idempotencyKey (proposta e sinistro), aggregate { type, id } (padrão: a apólice), transaction.
 */
async function callInsurer({ ctx, policy, operation, domainObject, idempotencyKey, aggregate, transaction }) {
  const connection = await ensureInsuranceConnection(ctx, transaction);
  const chave = idempotencyKey || `insurance-${operation}:${policy.id}:${crypto.randomUUID()}`;
  const { dispatch: criado } = await dispatchService.enqueue({
    companyId: ctx.companyId, connectionId: connection.id, operation, aggregateType: aggregate ? aggregate.type : 'InsurancePolicy', aggregateId: aggregate ? aggregate.id : policy.id, payload: domainObject, idempotencyKey: chave, userId: ctx.userId || null, transaction,
  });
  let dispatch = criado;
  const source = connection.providerCode === 'insurance-manual' ? 'MANUAL' : 'API';
  // Cotação é consulta (SAFE): se ficou incerta, o pedido é refeito pela pessoa. Proposta e sinistro ficam gravados como UNKNOWN.
  const incerto = () => (operation === 'quote' ? Promise.reject(E.providerUncertain()) : { uncertain: true, dispatch, response: null, source, connection });
  if (['PENDING', 'RETRY_WAIT'].includes(dispatch.status)) {
    await transitionDispatch(ctx, dispatch.id, 'SENDING', {}, { motivo: 'Envio pego pelo fluxo de seguros de Compras.' }, transaction);
    const r = await processClaimed(ctx, dispatch.id, { transaction });
    dispatch = await findDispatch(ctx, dispatch.id, transaction);
    if (!r.ok) {
      const erro = ERRORS.get(dispatch.id);
      ERRORS.delete(dispatch.id);
      // Recusa conhecida do adapter antigo (credencial incompleta, operação sem documentação pública): o erro de sempre, com o código de sempre.
      if (erro && erro.isOperational && String(erro.code || '').startsWith('PROCUREMENT_INSURANCE_')) throw erro;
      if (dispatch.status === 'UNKNOWN') return incerto();
      // Nada saiu (adiado) ou a seguradora recusou: o pedido não pode ficar na fila para uma nova tentativa que ninguém vai aplicar.
      if (['PENDING', 'RETRY_WAIT'].includes(dispatch.status)) {
        await transitionDispatch(ctx, dispatch.id, 'CANCELLED', {}, { motivo: 'O fluxo de seguros não aplica resultado de nova tentativa: o pedido é refeito pela pessoa.' }, transaction);
      }
      throw erro && erro.code && erro.statusCode && erro.statusCode < 500 ? erro : E.providerFailed(erro && erro.message ? erro.message : null, erro && erro.code ? { providerCode: erro.code } : undefined);
    }
    dispatch = await findDispatch(ctx, dispatch.id, transaction);
  }
  if (dispatch.status === 'UNKNOWN') return incerto();
  if (!['SUBMITTED', 'CONFIRMED'].includes(dispatch.status)) throw AppError.conflict(`O pedido anterior à seguradora está em ${dispatch.status}: confira com a seguradora antes de repetir.`, 'INTEGRATION_INSURANCE_DISPATCH_STATE');
  let response = RESPONSES.get(dispatch.id) || null;
  RESPONSES.delete(dispatch.id);
  if (!response) response = await fetchFromProvider(ctx, dispatch, connection, transaction);
  if (operation === 'propose' && source === 'API' && dispatch.status === 'SUBMITTED') await tryConfirmByStatus(ctx, dispatch, connection, transaction);
  return { dispatch, response, source, connection };
}

module.exports = { callInsurer, proposalKey, retryKey };
