'use strict';

const logger = require('../../../utils/logger');
const { sequelize, IntegrationProvider } = require('../../../models');
const { recordError } = require('../errors');
const { triggerContingency } = require('../providers/contingency.registry');
const { resolveCircuitPolicy } = require('./circuitPolicyReader');
const { evaluateAdmission, evaluateResult } = require('./circuitMachine');
const { toView, updateCircuitState } = require('./circuitState');
const { ensureCurrentRow, lockCurrentRow } = require('./healthStore');
const { circuitOpen, MENSAGEM_ABERTURA } = require('./circuit.errors');

/**
 * Circuit breaker persistido por connection (M9-D217). O estado mora em integration.provider_health (M9-D206), vale para todas as
 * instâncias e sobrevive a reinício. Cada decisão lê a linha com FOR UPDATE, aplica a máquina (circuitMachine.js) com a política
 * efetiva (circuitPolicy.js) e grava na mesma transação: duas instâncias nunca contam a mesma falha duas vezes nem abrem duas vezes.
 * Falha ao ler ou gravar o estado (savepoint desfeito) assume o último conhecido, registra no log e NUNCA bloqueia o sistema.
 */
const vistaTravada = async (connection, now, transaction) => {
  await ensureCurrentRow(connection, now, transaction);
  return toView(await lockCurrentRow(connection.id, transaction));
};

const aplica = (connection, patch, now, transaction) => (Object.keys(patch).length ? updateCircuitState(connection.id, patch, transaction, { now }) : null);

/** Roda `fn` num savepoint: se falhar, desfaz só ele e devolve `fallback`. */
async function seguro(transaction, rotulo, fallback, fn) {
  try {
    return await sequelize.transaction({ transaction }, fn);
  } catch (err) {
    logger.error({ err: err.message, code: err.code }, `Circuito: ${rotulo}`);
    return fallback;
  }
}

/** A abertura aciona a contingência da família (D226 a D228) e registra UM erro HIGH CIRCUIT_OPEN. Nenhum dos dois derruba o circuito. */
async function aoAbrir(connection, transaction) {
  const provider = await IntegrationProvider.findByPk(connection.providerCode, { transaction });
  await seguro(transaction, 'registrar o erro de abertura', null, (sp) => recordError(
    { groupId: connection.groupId, companyId: connection.companyId },
    {
      providerCode: connection.providerCode, connectionId: connection.id, source: 'HEALTH', errorClass: 'TRANSIENT', errorCode: 'CIRCUIT_OPEN', severity: 'HIGH', message: MENSAGEM_ABERTURA,
    },
    sp,
  ));
  if (provider) await triggerContingency({ domain: provider.domain, companyId: connection.companyId, providerCode: connection.providerCode }, transaction);
}

/**
 * Antes de chamar o fornecedor: { allowed, probe, state, reason?, until?, transition? }. `essential` atravessa o circuito aberto;
 * vencido o cooldown, a primeira admissão leva a HALF_OPEN e as próximas ocupam as vagas de teste (`probe`: true), até half_open_max_calls.
 * Quem recebe `probe: true` DEVE devolver o resultado por recordCallResult com `probe: true` (a vaga é liberada ali).
 */
async function admitCall(connection, ctx, transaction, { essential = false, now = new Date() } = {}) {
  const indisponivel = { allowed: true, probe: false, state: 'UNKNOWN', reason: 'CIRCUIT_STATE_UNAVAILABLE' };
  return seguro(transaction, 'ler o estado para admitir a chamada; seguindo sem o circuito', indisponivel, async (sp) => {
    const row = await vistaTravada(connection, now, sp);
    const policy = await resolveCircuitPolicy(ctx, connection, sp);
    const r = evaluateAdmission(row, policy, { essential, now });
    await aplica(connection, r.patch, now, sp);
    return { allowed: r.decision === 'ALLOW', probe: r.probe, state: r.state, reason: r.reason, until: r.until, transition: r.transition };
  });
}

/**
 * Depois da chamada: { ok, errorClass, probe }. Só TRANSIENT e UNKNOWN contam como falha; sucesso fecha (HALF_OPEN) ou zera a contagem (CLOSED).
 * Devolve { opened, closed, state }.
 */
async function recordCallResult(connection, ctx, transaction, { ok = false, errorClass = null, probe = false, now = new Date() } = {}) {
  const semMudanca = { opened: false, closed: false, state: 'UNKNOWN' };
  return seguro(transaction, 'gravar o resultado da chamada', semMudanca, async (sp) => {
    const row = await vistaTravada(connection, now, sp);
    const policy = await resolveCircuitPolicy(ctx, connection, sp);
    const r = evaluateResult(row, policy, { ok, errorClass, probe, now });
    const novo = await aplica(connection, r.patch, now, sp);
    if (r.opened) await aoAbrir(connection, sp);
    return { opened: r.opened === true, closed: r.closed === true, state: novo ? novo.circuitState : row.circuitState };
  });
}

/** Para quem chama sem fila: se o circuito não deixa, 503 INTEGRATION_CIRCUIT_OPEN. */
async function assertCallAllowed(connection, ctx, transaction, opts) {
  const r = await admitCall(connection, ctx, transaction, opts);
  if (!r.allowed) throw circuitOpen(r);
  return r;
}

module.exports = { admitCall, recordCallResult, assertCallAllowed };
