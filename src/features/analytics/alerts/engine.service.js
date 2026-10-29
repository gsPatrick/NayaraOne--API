'use strict';

/**
 * M9-D691 (3.1 e 3.5) — o alert engine de uma empresa. Carrega as definições PUBLISHED (nunca DRAFT/DISABLED), sincroniza os alertas semente a partir
 * dos parâmetros, avalia cada definição em transação PRÓPRIA (a falha de uma não impede as demais; o erro vai para o diário de refreshes como
 * `alert_evaluation` FAILED) e devolve o que fez. `transitionAlert` aplica a regra de transição (409 ANALYTICS_ALERT_INVALID_TRANSITION) à instância.
 * Nunca executa ação financeira (M9-D692): só abre, conta e resolve instâncias e emite eventos.
 */
const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const logger = require('../../../utils/logger');
const clock = require('../metrics/clock');
const { inCompany } = require('../companyTx');
const { listPublishedAlertDefinitions } = require('../alertDefinitionStore.service');
const { acknowledgeAlertInstance } = require('../alertInstanceStore.service');
const { startRefresh, finishRefresh } = require('../readModelRefreshStore.service');
const { readAlertParams } = require('./engine.settings');
const { evaluateDefinition } = require('./engine.definition');
const { evaluateFreshnessDefinition } = require('./engine.freshness');
const { syncSeedAlerts } = require('./seed.sync');
const { assertTransition } = require('./transitions');
const { resolveInstance } = require('./engine.instances');
const { cooldownMinutesOf } = require('./engine.state');

const REFRESH_LOG_MODEL = 'alert_evaluation';
const isFreshness = (def) => def.scope && def.scope.kind === 'FRESHNESS';

async function logFailure(scope, def, err) {
  try {
    await inCompany(scope, async (tx) => {
      const row = await startRefresh({ groupId: scope.groupId, companyId: scope.companyId, readModel: REFRESH_LOG_MODEL, trigger: 'SCHEDULE', version: def.version }, scope, tx);
      await finishRefresh(row.id, { status: 'FAILED', errorCode: String(err.code || 'ANALYTICS_ALERT_EVALUATION_FAILED').slice(0, 80), errorMessage: `${def.alert_code}: ${err.message}` }, scope, tx);
    });
  } catch (logErr) {
    logger.error({ event: 'analytics.alert.evaluation_log_failed', err: logErr }, '[analytics] não foi possível registrar a falha da avaliação do alerta');
  }
}

async function evaluateOne(def, scope, params, now) {
  const run = isFreshness(def) ? evaluateFreshnessDefinition : evaluateDefinition;
  const out = await inCompany(scope, (tx) => run(def, scope, params, now, tx));
  return Array.isArray(out) ? out : [out];
}

/** options: { now, seeds = true }. Devolve { results: [{ alertCode, action, ... }], failed: [{ alertCode, errorCode, message }] }. */
async function evaluateCompanyAlerts(scope, { now = clock.now(), seeds = true } = {}) {
  if (seeds) await syncSeedAlerts(scope, { now });
  const { params, defs } = await inCompany(scope, async (tx) => ({ params: await readAlertParams(scope, tx), defs: await listPublishedAlertDefinitions(scope, tx) }));
  const results = [];
  const failed = [];
  for (const def of defs) {
    try {
      results.push(...await evaluateOne(def, scope, params, now));
    } catch (err) {
      failed.push({ alertCode: def.alert_code, errorCode: err.code || 'ANALYTICS_ALERT_EVALUATION_FAILED', message: err.message });
      logger.error({ event: 'analytics.alert.evaluation_failed', alertCode: def.alert_code, companyId: scope.companyId, err }, '[analytics] avaliação do alerta falhou');
      await logFailure(scope, def, err);
    }
  }
  return { results, failed };
}

/**
 * Muda o estado de uma instância pelas regras do livro. Transição proibida: 409 com a mensagem única. ACKNOWLEDGED em nome do usuário do contexto
 * (rota da M9-D703); RESOLVED só pelo worker (GUC de escrita), por normalização, iniciando o cooldown.
 */
async function transitionAlert(instanceId, to, ctx, transaction) {
  const [rows] = await sequelize.query(
    `SELECT i.*, d.cooldown_minutes, d.severity AS def_severity FROM analytics.alert_instances i JOIN analytics.alert_definitions d ON d.id = i.alert_definition_id WHERE i.id = :id FOR UPDATE OF i`,
    { replacements: { id: instanceId }, transaction }
  );
  const row = rows[0];
  if (!row) throw AppError.notFound('Alerta não encontrado.', 'ANALYTICS_ALERT_INSTANCE_NOT_FOUND');
  assertTransition(row.status, to);
  if (to === 'ACKNOWLEDGED') return acknowledgeAlertInstance(instanceId, ctx, transaction);
  const params = await readAlertParams({ companyId: row.company_id }, transaction);
  const now = clock.now();
  const cooldownUntil = new Date(now.getTime() + cooldownMinutesOf({ cooldown_minutes: row.cooldown_minutes, severity: row.severity }, params) * 60000);
  return resolveInstance(instanceId, { reason: 'CONDITION_NORMALIZED', now, cooldownUntil }, transaction);
}

module.exports = { evaluateCompanyAlerts, transitionAlert, syncSeedAlerts, REFRESH_LOG_MODEL };
