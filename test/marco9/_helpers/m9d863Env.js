'use strict';

// Apoio dos testes M9-D863 com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js).
const { QueryTypes } = require('sequelize');
const base = require('./m9d861Env');
const { AuditLog } = require('../../../src/models');
const policies = require('../../../src/features/core-governance/finops/degradation/policy.service');
const { runDegradation } = require('../../../src/features/core-governance/finops/degradation/run');

const { sequelize } = base;

const FIVE = ['SWITCH_AI_MODEL_CHEAPER', 'PAUSE_MARKETING_CAMPAIGNS', 'REDUCE_LOG_LEVEL', 'LIMIT_EXPORT_SIZE', 'DEFER_NON_CRITICAL_JOBS'];
/** Política com os cinco passos: o 1º em 90 e os demais em 100 (padrões do livro). */
const fullPolicy = (budgetId) => ({ budgetId, steps: FIVE.map((step) => ({ step })) });

const putPolicy = (tenant, tx, body, now) => policies.putPolicy(tenant, body, tenant.userId, tx, now ? { now } : undefined);
const degrade = (tenant, tx, now = new Date()) => runDegradation(tenant, tx, { now });
const actionsOf = (budgetId, tx, where = 'TRUE') => sequelize.query(
  `SELECT *, period_start::text AS period_start FROM governance.degradation_actions WHERE budget_id = :budgetId AND ${where} ORDER BY applied_at, step`, { type: QueryTypes.SELECT, transaction: tx, replacements: { budgetId } }
);
const auditOf = (entityId, action, tx) => AuditLog.findAll({ where: { entityId: String(entityId), action }, transaction: tx });
/** Primeiro dia do mês seguinte ao de hoje, ao meio-dia de Brasília. */
const nextMonth = () => { const [y, m] = base.TODAY.split('-').map(Number); return new Date(Date.UTC(y, m, 1, 15)); };

module.exports = { ...base, FIVE, fullPolicy, putPolicy, degrade, actionsOf, auditOf, nextMonth, policies };
