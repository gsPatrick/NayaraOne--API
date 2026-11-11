'use strict';

const { AnomalyCase } = require('../../../../models');
const { resolveAntifraudThresholds } = require('./finance-antifraud.service');

// Anomalias abertas para o agente financeiro da camada de IA (M9-D036): somente leitura. Devolve os casos em aberto da empresa
// (finance.anomaly_cases) e os limiares da regra FIN-005 em vigor (Motor de Regras, com os parâmetros do painel), para a resposta dizer com
// que limite cada caso foi apontado.
const LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

async function getOpenAnomalies(tenant, transaction, { limit }) {
  const thresholds = await resolveAntifraudThresholds(tenant, transaction);
  const rows = await AnomalyCase.findAll({ where: { status: 'OPEN' }, order: [['created_at', 'DESC']], transaction });
  const byRisk = Object.fromEntries(LEVELS.map((l) => [l, 0]));
  for (const r of rows) if (r.riskLevel in byRisk) byRisk[r.riskLevel] += 1;
  return {
    generatedAt: new Date().toISOString(),
    source: 'finance.anomaly_cases',
    rule: {
      code: 'FIN-005', ruleVersionId: thresholds.ruleVersionId || null, historyMultiplier: thresholds.historyMultiplier,
      newAccountThreshold: thresholds.newAccountThreshold, cooldownHours: thresholds.cooldownHours,
    },
    openCount: rows.length,
    byRisk,
    items: rows.slice(0, limit).map((r) => ({
      caseId: r.id, caseType: r.caseType, riskLevel: r.riskLevel, reason: r.reason, relatedEntityId: r.relatedEntityId || null, createdAt: new Date(r.createdAt || r.created_at).toISOString(),
    })),
  };
}

module.exports = { getOpenAnomalies };
