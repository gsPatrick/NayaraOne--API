'use strict';

/**
 * M9-D697 (3.1 e 3.2) — qualidade efetiva de uma métrica numa data-base: o pior entre o que os checks de qualidade dizem (status.checks) e o que os
 * componentes dizem (KPI composto herda a pior qualidade de `components[]`, recursivamente). Só vale para a leitura de HOJE: leitura de dia passado
 * devolve o registro como foi gravado (M9-D609 3.4) e o estado dos checks é o de agora. Componente sem registro na data não conta (não há o que herdar).
 */
const { getSourceSpec } = require('../metrics/sourceRefs.spec');
const { checkQuality } = require('./status.checks');
const { worstStatus } = require('./status.priority');

const MISSING = new Set(['ANALYTICS_SNAPSHOT_NOT_AVAILABLE', 'ANALYTICS_METRIC_NOT_FOUND']);

async function componentStatus(code, scope, asOfDate, transaction, visited) {
  const { readMetricAsOfUnchecked } = require('../metrics/registry.asOf'); // tardio: registry.asOf apresenta o snapshot por este módulo
  try {
    const read = await readMetricAsOfUnchecked(
      { companyId: scope.companyId, groupId: scope.groupId, permissions: [] },
      { metricCode: code, scopeType: 'COMPANY', scopeId: scope.companyId, asOfDate }, transaction, { visited }
    );
    return read.status;
  } catch (err) {
    if (MISSING.has(err.code)) return null;
    throw err;
  }
}

async function inheritedFrom(metricCode, scope, asOfDate, transaction, visited) {
  const spec = getSourceSpec(metricCode);
  if (!spec || !spec.components) return [];
  const seen = new Set([...visited, metricCode]);
  const out = [];
  for (const code of spec.components) {
    if (seen.has(code)) continue; // referência circular nunca trava a leitura
    const status = await componentStatus(code, scope, asOfDate, transaction, seen);
    if (status && status !== 'OK') out.push({ metricCode: code, status });
  }
  return out;
}

/** { status, degradedBy, inheritedFrom }: `status` é OK, STALE, DEGRADED ou INCOMPLETE (o pior que os checks e os componentes impõem). */
async function assessQuality({ metricCode, scope, asOfDate, historical = false, transaction, visited = new Set() }) {
  if (historical) return { status: 'OK', degradedBy: [], inheritedFrom: [] };
  const checks = await checkQuality(metricCode, scope, transaction);
  const inherited = await inheritedFrom(metricCode, scope, asOfDate, transaction, visited);
  return { status: worstStatus(checks.status, ...inherited.map((c) => c.status)), degradedBy: checks.degradedBy, inheritedFrom: inherited };
}

module.exports = { assessQuality };
