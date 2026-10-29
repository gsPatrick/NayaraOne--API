'use strict';

const { Opportunity } = require('../../models');
const { CLOSED_STAGES } = require('./opportunityNextAction.validator');

/** Funil do CRM para o agente da Diretoria da camada de IA (M9-D035): oportunidades em aberto por etapa, em quantidade e valor esperado. Somente agregados. */
const toCents = (v) => Math.round((Number(v) || 0) * 100);

async function getPipelineSummary(transaction) {
  const rows = await Opportunity.findAll({ attributes: ['stage', 'expectedValue'], transaction });
  const by = new Map();
  for (const r of rows) {
    if (CLOSED_STAGES.includes(String(r.stage).toUpperCase())) continue;
    const e = by.get(r.stage) || { stage: r.stage, count: 0, cents: 0 };
    e.count += 1;
    e.cents += toCents(r.expectedValue);
    by.set(r.stage, e);
  }
  const byStage = [...by.values()].sort((a, b) => (a.stage < b.stage ? -1 : 1)).map((e) => ({ stage: e.stage, count: e.count, value: e.cents / 100 }));
  return {
    generatedAt: new Date().toISOString(),
    source: 'crm.opportunities',
    openCount: byStage.reduce((s, e) => s + e.count, 0),
    openValue: byStage.reduce((s, e) => s + toCents(e.value), 0) / 100,
    byStage,
  };
}

module.exports = { getPipelineSummary };
