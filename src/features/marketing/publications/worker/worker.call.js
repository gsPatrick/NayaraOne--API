'use strict';

const { CHANNEL_META } = require('../adapters/channels');
const { sendToChannel } = require('../adapters/sendToChannel');
const content = require('../../content');
const { loadVersion, buildPayload, addressPolicyOf, mediaOf } = require('./worker.content');
const logger = require('../../../../utils/logger');

/** Erros que provam que NADA saiu para o canal e que repetir não adianta: a causa está no pedido ou no estado, não na rede. */
const isDefinitive = (err) => Number.isInteger(err && err.statusCode) && err.statusCode >= 400 && err.statusCode < 500;
/** Erros anteriores ao envio que se resolvem sozinhos: o job volta a PENDING sem gastar tentativa. */
const RELEASE_CODES = Object.freeze(['MKT_KILL_SWITCH_ACTIVE', 'INTEGRATION_CIRCUIT_OPEN', 'CIRCUIT_OPEN']);
/** Erros anteriores ao envio (adapter ainda não chamado) que contam como tentativa e voltam com espera. */
const NOT_SENT_CODES = Object.freeze(['MKT_CHANNEL_NOT_RELEASED', 'INTEGRATION_CONNECTION_NOT_FOUND', 'MKT_CHANNEL_CONNECTION_INACTIVE']);

function withTimeout(work, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs); });
  const guarded = work.then((value) => ({ value }), (error) => ({ error }));
  return Promise.race([guarded, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Envia o job ao canal (M9-D411 itens 2 e 6): a segunda barreira de conteúdo público (deliverToAdapter, M9-D403) entrega ao `sendToChannel` (M9-D430), que reconfere o
 * kill switch na hora, escolhe o adapter (sandbox enquanto o canal não está liberado) e envia com a chave do job. O tempo é limitado por `timeoutS`. Não grava nada;
 * devolve a classificação para o passo seguinte: RESULT (resposta do canal), TIMEOUT (sem resposta no prazo), RELEASE (nada saiu, sem gastar tentativa), NOT_SENT
 * (nada saiu, conta a tentativa), DEFINITIVE (pedido recusado antes do envio) ou EXCEPTION (falha inesperada: tratada como incerta, nunca como "não saiu").
 */
async function sendJob({ tenant, job, timeoutS, transaction, scenarioFor }) {
  const version = await loadVersion(job, transaction);
  const operation = CHANNEL_META[job.channel].operation;
  const scenario = scenarioFor ? scenarioFor(job) : undefined;
  const media = mediaOf(version);
  const adapter = { [operation]: (payload) => sendToChannel(job.channel, payload, { tenant, transaction, idempotencyKey: job.idempotency_key, campaignId: job.campaign_id, ...(scenario ? { scenario } : {}), ...(media ? { media } : {}) }) };
  const outcome = await withTimeout(
    content.adapterGate.deliverToAdapter(adapter, operation, buildPayload(version), { policy: addressPolicyOf(version), tenant, transaction }),
    timeoutS * 1000
  );
  if (outcome.timedOut) return { kind: 'TIMEOUT' };
  if (outcome.error) {
    const err = outcome.error;
    const code = err && err.code;
    if (RELEASE_CODES.includes(code)) return { kind: 'RELEASE', code };
    if (NOT_SENT_CODES.includes(code)) return { kind: 'NOT_SENT', code };
    if (isDefinitive(err)) return { kind: 'DEFINITIVE', code: code || 'MKT_VALIDATION' };
    logger.error({ jobId: job.id, channel: job.channel, err: err && err.message }, 'marketing.publication.worker.send_exception');
    return { kind: 'EXCEPTION', code: 'MKT_PUBLICATION_ADAPTER_EXCEPTION' };
  }
  return { kind: 'RESULT', result: outcome.value.result };
}

module.exports = { sendJob, withTimeout };
