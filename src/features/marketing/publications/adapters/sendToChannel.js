'use strict';

const { CHANNEL_META } = require('./channels');
const { normalizeChannel } = require('./channel.errors');
const { resolveChannelAdapter } = require('./release/channelAccess');
const { decideOnResult } = require('./contingency/channelContingency');
const gate = require('./circuit.gate');
const { assertOutboundAllowed } = require('../../killswitch.state');
const { assertPublicPayload } = require('../../security/publicPayload');

/** Resposta sintética do sandbox que passou do tempo máximo: resultado incerto (UNKNOWN), nunca falha presumida (Guia §9). */
const timeoutResult = (adapter, operation, idempotencyKey) => adapter.result(operation, idempotencyKey, {
  status: 'UNKNOWN', unknown: true, error: { class: 'UNKNOWN', code: 'TIMEOUT', httpStatus: null, message: 'Sem resposta do canal no prazo: confirme antes de repetir.' },
});

async function readTimeoutMs(tenant, transaction) {
  const { getSetting } = require('../../../settings/settings.service'); // leitura tardia: o dicionário de parâmetros carrega os arquivos de canal
  const { KEYS, WORKER_SETTING_DEFAULTS } = require('../worker/worker.settings');
  const seconds = Number(await getSetting(KEYS.timeout, tenant, transaction, WORKER_SETTING_DEFAULTS[KEYS.timeout]));
  return (Number.isInteger(seconds) && seconds >= 1 ? seconds : WORKER_SETTING_DEFAULTS[KEYS.timeout]) * 1000;
}

/** Espera o adapter até `timeoutMs`; passado o prazo devolve { timedOut: true } (o envio segue por conta do canal, e a reconciliação decide). */
function raceTimeout(work, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs); });
  return Promise.race([work.then((value) => ({ value })), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Porta de saída do Marketing para um canal: escolhe o adapter pela liberação (sandbox enquanto o canal não está liberado; produção só depois, e
 * 409 MKT_CHANNEL_NOT_RELEASED se alguém pedir produção antes), executa send/publish com a chave de idempotência e junta a decisão de contingência do
 * canal. O resultado vem marcado sandbox = true/false: o simulado nunca é confundido com envio real. `scenario` só vale no sandbox (o real recusa).
 * KILL SWITCH (M9-D425): antes de qualquer outra coisa, global, canal, `campaignId` e `automationId` (quando a ação tem) são lidos na hora, sem cache; basta UM ligado, ou o estado
 * ilegível, para a saída ser recusada com 423 MKT_KILL_SWITCH_ACTIVE e nenhum adapter ser sequer resolvido.
 * FALHA DE PROVEDOR (M9-D442), só no sandbox (em produção o cliente HTTP do bloco B já faz isso): o circuito da conexão é admitido antes da chamada (aberto = 503
 * INTEGRATION_CIRCUIT_OPEN, nada sai) e alimentado com o resultado; passado o tempo máximo do adapter (`marketing.worker.timeout_s`) a resposta vale como TIMEOUT (UNKNOWN); e
 * credencial REVOGADA pelo provedor trava o canal como conta comprometida (M9-D433). `circuit`: recibo { connectionId, probe } de quem já admitiu (o worker, que também informa o
 * resultado); sem ele o próprio sendToChannel admite e informa. `now`: relógio do circuito.
 */
async function sendToChannel(channelName, message, { tenant, transaction, idempotencyKey, mode = 'AUTO', scenario, campaignId, automationId, media, circuit, now = new Date() } = {}) {
  const channel = normalizeChannel(channelName);
  await assertOutboundAllowed(tenant, { channel, campaignId, automationId }, transaction);
  if (CHANNEL_META[channel].operation === 'publish') assertPublicPayload(message, channel); // canal público só recebe PublicPayload (M9-D440), depois do kill switch
  const adapter = await resolveChannelAdapter(channel, { tenant, transaction, mode });
  const operation = CHANNEL_META[channel].operation;
  const selfManaged = adapter.isSandbox && circuit === undefined;
  const handle = selfManaged ? await gate.admitForSend(channel, { tenant, transaction, now }) : (circuit || null);
  const options = { idempotencyKey, ...(scenario ? { scenario } : {}), ...(media ? { media } : {}) }; // media: resumo da mídia do conteúdo (M9-D428), conferido pelo adapter da rede
  let result;
  try {
    if (adapter.isSandbox) {
      const outcome = await raceTimeout(adapter[operation](message, options), await readTimeoutMs(tenant, transaction));
      result = outcome.timedOut ? timeoutResult(adapter, operation, idempotencyKey) : outcome.value;
    } else {
      result = await adapter[operation](message, options);
    }
  } catch (err) {
    if (selfManaged) await gate.report(handle, { kind: 'EXCEPTION' }, { tenant, transaction, now });
    throw err;
  }
  if (selfManaged) await gate.report(handle, { kind: 'RESULT', result }, { tenant, transaction, now });
  const security = require('../../security'); // carga tardia: a área de segurança importa os adapters
  if (security.isAuthRevoked(result.error)) await security.reportAuthRevoked({ tenant, channel, transaction, now });
  return { ...result, contingency: decideOnResult(channel, result) };
}

module.exports = { sendToChannel };
