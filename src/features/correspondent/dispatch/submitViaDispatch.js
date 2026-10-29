'use strict';

const { sequelize, IntegrationDispatch } = require('../../../models');
const AppError = require('../../../utils/AppError');
const dispatchService = require('../../integrations/dispatch/enqueue/dispatch.service');
const { transitionDispatch } = require('../../integrations/dispatch/dispatch.transition');
const { confirmDispatch } = require('../../integrations/dispatch/worker/worker.confirm');
const { processClaimed } = require('../../integrations/dispatch/worker/worker.process');
const { registerCallObserver } = require('../../integrations/dispatch/worker/worker.hooks');
const { tenantTx } = require('../../integrations/dispatch/worker/tenantTx');
const adapterRegistry = require('../../integrations/registry/adapterRegistry');
const { switchToAlternate } = require('../../integrations/contingency/contingency.switch');
const { ensureFinancingConnection } = require('./financingConnection');
const { buildSubmitDomainObject } = require('./submitPayload');

/**
 * O pedido do caso ao provider passa pelo Dispatch Service (M9-D240 3.1): a intenção nasce em integration.dispatches (`enqueue`, conteúdo minimizado pelo mapper
 * financing.submitCase, chave de idempotência = a chave da submissão) e a chamada ao fornecedor sai pelo worker de envios (circuito, cota e nova tentativa do
 * framework). O Correspondente guarda a regra dele: resposta incerta nunca vira reenvio às cegas (o envio da fila é cancelado e a submissão vira UNKNOWN, resolvida
 * por consulta pela chave); fornecedor fora sai pelo alternativo da contingência (D226) ou espera.
 */
const SUBMITTED_OK = ['SUBMITTED', 'CONFIRMED'];
const TRANSIENT_ERRORS = new Map();
const RAW_RESPONSES = new Map();
const MAX_REMEMBERED = 500;
const OPERATIONS = ['submitCase', 'requestAppraisal'];

const remember = (map, key, value) => {
  if (map.size >= MAX_REMEMBERED) map.delete(map.keys().next().value);
  map.set(key, value);
};

// O worker não devolve ao domínio o erro nem a resposta bruta do fornecedor (só a classe e o resultado normalizado); o Correspondente guarda a mensagem do erro na
// submissão (SUB-05) e usa o valor da avaliação, que só vem na resposta bruta: o observador do worker os anota por envio, em memória, até quem chamou ler.
registerCallObserver(({ dispatch, error, response }) => {
  if (!OPERATIONS.includes(dispatch.operation)) return;
  if (error) remember(TRANSIENT_ERRORS, dispatch.id, error);
  else if (response) remember(RAW_RESPONSES, dispatch.id, response);
});

const runner = (ctx, transaction) => (fn) => (transaction ? sequelize.transaction({ transaction }, fn) : tenantTx(ctx, fn));

function successOf(dispatch, usedAlternate) {
  const adapter = adapterRegistry.instantiate(dispatch.providerCode);
  const bruta = RAW_RESPONSES.get(dispatch.id);
  RAW_RESPONSES.delete(dispatch.id);
  const original = bruta && bruta.raw && typeof bruta.raw === 'object' ? bruta.raw : null;
  return {
    result: dispatch.operation === 'requestAppraisal' && original
      ? { ...original, externalId: dispatch.externalResourceId || original.externalId, raw: { via: 'dispatch', dispatchId: dispatch.id } }
      : { externalId: dispatch.externalResourceId, status: dispatch.externalStatus, raw: { via: 'dispatch', dispatchId: dispatch.id, provider: dispatch.providerCode } },
    adapter: adapter && adapter.legacyAdapterSync ? adapter.legacyAdapterSync() : null, dispatchId: dispatch.id, usedAlternate,
  };
}

/** Pedido para a conta: devolve o envio existente (mesma chave) ou cria. `spec`: operation, aggregateType, aggregateId, idempotencyKey, buildPayload(t). */
async function enqueueOperation({ ctx, financingCase, spec, transaction }) {
  const run = runner(ctx, transaction);
  return run(async (t) => {
    const connection = await ensureFinancingConnection(ctx, financingCase.providerCode, t);
    return dispatchService.enqueue({
      companyId: ctx.companyId, connectionId: connection.id, operation: spec.operation, aggregateType: spec.aggregateType, aggregateId: spec.aggregateId,
      payload: await spec.buildPayload(t), idempotencyKey: spec.idempotencyKey, userId: ctx.userId || null, transaction: t,
    });
  });
}

/** O envio ainda está na fila e o fornecedor não pode atender agora: troca pelo alternativo da contingência, se a política tiver um elegível. */
async function tryAlternate(ctx, dispatchId, transaction) {
  try {
    const r = await runner(ctx, transaction)((t) => switchToAlternate(ctx, dispatchId, { auto: true }, t));
    return r.switched ? r.toDispatchId : null;
  } catch {
    return null;
  }
}

/**
 * callViaDispatch — devolve { result, adapter, dispatchId, usedAlternate } (aceito), { error } (falhou ou incerto) ou { deferred } (o fornecedor não pôde atender agora e
 * nada foi enviado). `args`: ctx, financingCase, spec, timeoutMs, withTimeout (o do Correspondente), transaction (opcional: roda tudo nela, em savepoints).
 */
async function callViaDispatch(args) {
  const { ctx, timeoutMs, withTimeout, transaction } = args;
  const run = runner(ctx, transaction);
  let dispatch;
  try {
    ({ dispatch } = await enqueueOperation(args));
  } catch (error) {
    return { error };
  }
  let usedAlternate = false;
  for (let salto = 0; salto < 2; salto += 1) {
    if (SUBMITTED_OK.includes(dispatch.status)) return successOf(dispatch, usedAlternate);
    if (!['PENDING', 'RETRY_WAIT'].includes(dispatch.status)) return { error: new Error(`O envio ao provider está em ${dispatch.status}: confira com o provider antes de reenviar.`) };
    // eslint-disable-next-line no-await-in-loop
    await run((t) => transitionDispatch(ctx, dispatch.id, 'SENDING', {}, { motivo: 'Envio pego pelo fluxo do Correspondente.' }, t));
    let r;
    try {
      // eslint-disable-next-line no-await-in-loop
      r = await withTimeout(processClaimed(ctx, dispatch.id, { transaction }), timeoutMs);
    } catch (error) {
      return { error };
    }
    // eslint-disable-next-line no-await-in-loop
    const atual = await run((t) => IntegrationDispatch.findOne({ where: { id: dispatch.id, companyId: ctx.companyId }, transaction: t }));
    if (r.ok) {
      // A avaliação responde COMPLETED na hora e não tem webhook nem consulta depois: o status final da resposta é a evidência (ON_STATUS) que confirma o envio.
      if (atual.operation === 'requestAppraisal' && atual.status === 'SUBMITTED' && String(atual.externalStatus).toUpperCase() === 'COMPLETED') {
        // eslint-disable-next-line no-await-in-loop
        await run((t) => confirmDispatch(ctx, atual.id, { source: 'STATUS_QUERY', status: atual.externalStatus, externalResourceId: atual.externalResourceId }, t));
      }
      return successOf(atual, usedAlternate);
    }
    if (r.deferred) {
      // eslint-disable-next-line no-await-in-loop
      const outro = await tryAlternate(ctx, dispatch.id, transaction);
      if (!outro) return { deferred: r.deferred, dispatchId: dispatch.id };
      // eslint-disable-next-line no-await-in-loop
      dispatch = await run((t) => IntegrationDispatch.findOne({ where: { id: outro, companyId: ctx.companyId }, transaction: t }));
      usedAlternate = true;
      continue;
    }
    // Falhou ou ficou incerto: o envio não pode ser repetido pelo worker (nunca reenviar às cegas); a submissão vira UNKNOWN e se resolve por consulta pela chave.
    if (atual && atual.status === 'RETRY_WAIT') {
      // eslint-disable-next-line no-await-in-loop
      await run((t) => transitionDispatch(ctx, atual.id, 'CANCELLED', {}, { motivo: 'Resultado incerto: o Correspondente confere pela chave de idempotência antes de qualquer reenvio.' }, t));
    }
    const erro = TRANSIENT_ERRORS.get(dispatch.id) || r.error || AppError.internal('O envio ao provider não foi concluído.', 'INTEGRATION_DISPATCH_NOT_COMPLETED');
    TRANSIENT_ERRORS.delete(dispatch.id);
    return { error: erro };
  }
  return { deferred: 'ALTERNATE_ALSO_UNAVAILABLE', dispatchId: dispatch.id };
}

/** Envio do caso ao provider (submitCase): a chave é a da submissão; o conteúdo, o objeto de domínio minimizado pelo mapper financing.submitCase. */
function submitViaDispatch({ submission, financingCase, ...resto }) {
  return callViaDispatch({
    ...resto, financingCase,
    spec: {
      operation: 'submitCase', aggregateType: 'ProviderSubmission', aggregateId: submission.id, idempotencyKey: submission.idempotencyKey,
      buildPayload: (t) => buildSubmitDomainObject(financingCase, submission.requestSnapshot, t),
    },
  });
}

/** Pedido de avaliação do imóvel ao provider (requestAppraisal): conteúdo = o pedido guardado na avaliação (referências, sem dado pessoal). */
function requestAppraisalViaDispatch({ appraisal, financingCase, ...resto }) {
  const snapshot = appraisal.requestSnapshot || {};
  return callViaDispatch({
    ...resto, financingCase,
    spec: {
      operation: 'requestAppraisal', aggregateType: 'Appraisal', aggregateId: appraisal.id, idempotencyKey: snapshot.idempotencyKey || `appraisal:${appraisal.id}`,
      buildPayload: async () => { const { idempotencyKey: _chave, ...pedido } = snapshot; return pedido; },
    },
  });
}

module.exports = { submitViaDispatch, requestAppraisalViaDispatch };
