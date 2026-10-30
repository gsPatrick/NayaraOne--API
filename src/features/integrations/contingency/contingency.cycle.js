'use strict';

const logger = require('../../../utils/logger');
const { sequelize, IntegrationConnection } = require('../../../models');
const { getServerEnvironment } = require('../registry/registry.helpers');
const { MODES_WITH_ALTERNATE } = require('./contingency.constants');
const { resolveContingencyPolicy } = require('./contingency.policy');
const { readContingencyParams } = require('./contingency.params');
const { connectionReasons } = require('./contingency.triggers');
const { activateContingency } = require('./contingency.activate');
const { findActive, listActiveRows } = require('./contingency.state');
const { findAgedQueued } = require('./contingency.queueAge');
const { publishManualTask } = require('./contingency.manualTask');
const { autoSwitchQueued } = require('./contingency.autoSwitch');
const { tryRecover } = require('./contingency.recovery');
const { handleAged, runDomainStep } = require('./contingency.domainHooks');

/** Item da fila que passou do prazo vira tarefa manual (um evento por envio). Devolve quantos eventos novos saíram. */
async function publishAgedAsTasks(ctx, connection, policy, params, now, transaction) {
  const itens = await findAgedQueued(ctx, connection.id, policy.queueMaxAgeH, now, params.manualTaskBatchSize, transaction);
  let tarefas = 0;
  for (const item of itens) {
    // O domínio pode resolver o item vencido sozinho (o marketing do WhatsApp é cancelado, não vira tarefa): M9-D227.
    const tratado = await handleAged(policy.domain, ctx, item, policy, now, transaction);
    if (tratado && tratado.handled) continue;
    await publishManualTask(ctx, { item, policy, domain: policy.domain, dueH: params.manualTaskDueH, now }, transaction);
    tarefas += 1;
  }
  return tarefas;
}

/** Passo de UMA connection: ativa pelos gatilhos, troca a fila para o alternativo e transforma o vencido em tarefa manual. */
async function stepConnection(ctx, connection, params, now, transaction, resumo) {
  const policy = await resolveContingencyPolicy(ctx, connection, transaction);
  if (!policy) return null;
  const motivos = await connectionReasons(ctx, connection, policy, now, transaction);
  let ativa = await findActive(ctx, { connectionId: connection.id }, transaction);
  if (motivos.length && !ativa) {
    const r = await activateContingency(ctx, { connection }, motivos, transaction);
    if (r.activated) { resumo.activated += 1; resumo.createdNow.add(r.row.id); }
    ativa = r.row || ativa;
  }
  if (!ativa) return null;
  if (MODES_WITH_ALTERNATE.includes(policy.mode) && policy.alternateConnectionId) {
    resumo.switched += (await autoSwitchQueued(ctx, connection, policy.domain, params.drainBatchSize, now, transaction)).length;
  }
  const passo = await runDomainStep(policy.domain, ctx, { connection, policy, params, now }, transaction);
  if (passo && passo.switched) resumo.switched += passo.switched;
  if (policy.queueMaxAgeH !== null) resumo.manualTasks += await publishAgedAsTasks(ctx, connection, policy, params, now, transaction);
  return ativa;
}

/**
 * Rodada da contingência de UMA empresa (M9-D226): é o passo registrado no ciclo do worker de envios (registerDispatchCycleStep). Avalia os gatilhos de
 * cada connection (ACTIVE, PAUSED ou AUTH_FAILED do ambiente do servidor), troca a fila para o alternativo quando permitido, gera as tarefas manuais do que
 * venceu e encerra as contingências recuperadas. Ativar de novo é no-op; reexecutar a rodada não duplica nada. Devolve o resumo.
 */
async function runContingencyCycle(ctx, { now = new Date() } = {}, transaction) {
  const resumo = { activated: 0, deactivated: 0, switched: 0, manualTasks: 0, drained: 0, createdNow: new Set() };
  const params = await readContingencyParams(ctx, transaction);
  const connections = await IntegrationConnection.findAll({
    where: { companyId: ctx.companyId, environment: getServerEnvironment(), status: ['ACTIVE', 'PAUSED', 'AUTH_FAILED'] }, order: [['created_at', 'ASC']], transaction,
  });
  for (const connection of connections) {
    try {
      await sequelize.transaction({ transaction }, (sp) => stepConnection(ctx, connection, params, now, sp, resumo));
    } catch (err) {
      logger.warn({ connectionId: connection.id, err: err.message, code: err.code }, 'Contingência: falha ao avaliar a integração; a rodada segue.');
    }
  }
  for (const row of await listActiveRows(ctx, transaction)) {
    if (resumo.createdNow.has(row.id)) continue;
    try {
      const r = await sequelize.transaction({ transaction }, (sp) => tryRecover(ctx, row, now, sp));
      if (r.deactivated) { resumo.deactivated += 1; resumo.drained += r.drained.length; }
    } catch (err) {
      logger.warn({ contingencyId: row.id, err: err.message, code: err.code }, 'Contingência: falha ao tentar encerrar; a rodada segue.');
    }
  }
  const { createdNow, ...saida } = resumo;
  return saida;
}

module.exports = { runContingencyCycle, stepConnection };
