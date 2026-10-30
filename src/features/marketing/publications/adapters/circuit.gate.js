'use strict';

const { IntegrationConnection } = require('../../../../models');
const health = require('../../../integrations/health');

/**
 * Circuit breaker da conexão do canal no SANDBOX (M9-D217 pelo framework de Integrações; failure drill da M9-D442). O canal em produção usa o cliente HTTP único do bloco B, que
 * já passa pelo circuito; o sandbox não tem cliente HTTP e por isso é aqui que o circuito da conexão é admitido e alimentado, com o mesmo estado persistido (provider_health):
 *  - `coolingDown`: leitura sem efeito, para o worker nem pegar o job enquanto o circuito está aberto dentro do cooldown (vale nos dois modos);
 *  - `admit`: fechado deixa passar; aberto dentro do cooldown segura; vencido o cooldown meia-abre e ocupa uma vaga de teste (`probe`), até `half_open_max_calls`;
 *  - `report`: devolve o resultado ao circuito. Só falha de provedor (TRANSIENT e UNKNOWN: 5xx, timeout, resposta incerta) conta contra ele; limite (429), credencial e recusa não abrem
 *    o circuito e, se a chamada ocupava uma vaga de teste, apenas a devolvem.
 * O relógio é o do chamador (`now`).
 */
const circuitCtx = (tenant) => ({ groupId: tenant.groupId, companyId: tenant.companyId, userId: null });
const loadConnection = (connectionId, transaction) => IntegrationConnection.findByPk(connectionId, { transaction });

/** O circuito está aberto E ainda dentro do cooldown? (leitura pura: não meia-abre, não ocupa vaga). */
async function coolingDown(connectionId, { tenant, transaction, now }) {
  const view = await health.getCurrentHealth(connectionId, circuitCtx(tenant), transaction, { now });
  if (view.circuitState !== 'OPEN' || !view.circuitOpenedAt) return false;
  let cooldownS = view.circuitCooldownS;
  if (!Number.isInteger(cooldownS)) {
    const connection = await loadConnection(connectionId, transaction);
    cooldownS = connection ? (await health.resolveCircuitPolicy(circuitCtx(tenant), connection, transaction)).cooldown_s : 0;
  }
  return now.getTime() < new Date(view.circuitOpenedAt).getTime() + cooldownS * 1000;
}

/** { allowed, probe, reason } do circuito da conexão; conexão que sumiu não bloqueia aqui (quem resolve a conexão decide). */
async function admit(connectionId, { tenant, transaction, now }) {
  const connection = await loadConnection(connectionId, transaction);
  if (!connection) return { allowed: true, probe: false };
  const out = await health.admitCall(connection, circuitCtx(tenant), transaction, { now });
  return { allowed: out.allowed, probe: out.probe === true, reason: out.reason, until: out.until };
}

/** Para quem envia direto (sem o worker): resolve a conexão do canal e admite, ou lança 503 INTEGRATION_CIRCUIT_OPEN. Devolve o recibo { connectionId, probe }. */
async function admitForSend(channel, { tenant, transaction, now }) {
  const { resolveChannelConnection } = require('../schedule/schedule.connection'); // carga tardia: a conexão do agendamento importa os adapters
  const ref = await resolveChannelConnection({ tenant, actor: null, channel, transaction, circuitAware: true });
  const connection = await loadConnection(ref.id, transaction);
  const out = await health.assertCallAllowed(connection, circuitCtx(tenant), transaction, { now });
  return { connectionId: connection.id, probe: out.probe === true };
}

/** O que a resposta do canal significa para o circuito: { ok, errorClass } ou null quando nada saiu para o canal. */
function verdictOf(sent) {
  if (sent.kind === 'TIMEOUT' || sent.kind === 'EXCEPTION') return { ok: false, errorClass: 'UNKNOWN' };
  if (sent.kind !== 'RESULT') return null;
  const result = sent.result || {};
  if (result.unknown) return { ok: false, errorClass: 'UNKNOWN' };
  if (result.duplicate && result.providerRef) return { ok: true, errorClass: null }; // a mesma chave devolveu o post original: o canal respondeu bem
  if (result.error) return { ok: false, errorClass: result.error.class || 'UNKNOWN' };
  return { ok: true, errorClass: null };
}

/** Devolve o resultado ao circuito. `handle` = { connectionId, probe } do recibo da admissão; sem recibo não faz nada. */
async function report(handle, sent, { tenant, transaction, now }) {
  if (!handle || !handle.connectionId) return null;
  const verdict = verdictOf(sent);
  if (!verdict && !handle.probe) return null;
  const connection = await loadConnection(handle.connectionId, transaction);
  if (!connection) return null;
  // Nada saiu (kill switch, recusa antes do envio): só devolve a vaga de teste, se havia, sem contar como sucesso nem falha.
  const { ok, errorClass } = verdict || { ok: false, errorClass: 'VALIDATION' };
  return health.recordCallResult(connection, circuitCtx(tenant), transaction, { ok, errorClass, probe: handle.probe, now });
}

module.exports = { coolingDown, admit, admitForSend, report, verdictOf };
