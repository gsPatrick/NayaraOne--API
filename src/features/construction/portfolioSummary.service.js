'use strict';

const { Project } = require('../../models');
const { getProjectHealth } = require('./projectHealth.service');

/** Carteira de obras em execução para o agente da Diretoria da camada de IA (M9-D035): contagens e médias, sem identificar obra. `limit` é o teto de obras lidas. */
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

async function getPortfolioProgress(transaction, { limit }) {
  const projects = await Project.findAll({ where: { status: 'ACTIVE' }, order: [['created_at', 'DESC']], limit: limit + 1, transaction });
  const scanned = projects.slice(0, limit);
  let overdue = 0;
  let belowMargin = 0;
  let physical = 0;
  let planned = 0;
  for (const p of scanned) {
    const h = await getProjectHealth(p.id, transaction); // sequencial: a transação do tenant é uma só conexão
    const k = h.kpis || {};
    if (k.isOverdue) overdue += 1;
    if (h.belowMinMargin) belowMargin += 1;
    physical += Number(k.physicalProgressPct) || 0;
    planned += Number(k.plannedProgressPct) || 0;
  }
  const n = scanned.length;
  return {
    generatedAt: new Date().toISOString(),
    source: 'construction.projects',
    activeCount: n,
    overdueCount: overdue,
    belowMinMarginCount: belowMargin,
    avgPhysicalProgressPct: n ? round2(physical / n) : 0,
    avgPlannedProgressPct: n ? round2(planned / n) : 0,
    truncated: projects.length > limit,
  };
}

module.exports = { getPortfolioProgress };
