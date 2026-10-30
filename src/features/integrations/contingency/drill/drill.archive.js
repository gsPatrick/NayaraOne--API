'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { reportDir } = require('./drill.report');

/**
 * Relatórios arquivados do ensaio de falha de um fornecedor (M9-D256): o mais recente de cada cenário. O nome do arquivo não é lido (o código do fornecedor
 * tem hífens); vale o conteúdo (`kind`, `provider`, `scenario`, `startedAt`). Arquivo ilegível é ignorado.
 */
function latestDrillReports(providerCode, dir = reportDir()) {
  if (!fs.existsSync(dir)) return new Map();
  const porCenario = new Map();
  for (const nome of fs.readdirSync(dir)) {
    if (!nome.startsWith(`failure-drill-${providerCode}-`) || !nome.endsWith('.json')) continue;
    let r;
    try { r = JSON.parse(fs.readFileSync(path.join(dir, nome), 'utf8')); } catch { continue; }
    if (!r || r.kind !== 'contingency-failure-drill' || r.provider !== providerCode || typeof r.scenario !== 'string') continue;
    const atual = porCenario.get(r.scenario);
    if (!atual || Date.parse(r.startedAt) >= Date.parse(atual.startedAt)) porCenario.set(r.scenario, r);
  }
  return porCenario;
}

module.exports = { latestDrillReports };
