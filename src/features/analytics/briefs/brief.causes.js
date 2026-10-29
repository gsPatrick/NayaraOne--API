'use strict';

/**
 * M9-D694 (3.2 item 3) — registros de causa que a NAY pode citar. Causa só existe quando o próprio sistema a registra: o administrador diz
 * quais indicadores trazem uma dimensão de motivo (`analytics.brief.fontes_causa`, por exemplo crm.loss_reasons=motivo, o motivo de perda
 * informado por humano) e o servidor entrega cada valor gravado dessa dimensão como um registro citável, com identificador estável. Sem
 * registro nenhum, a lista fica vazia e qualquer afirmação de causa do modelo é bloqueada (groundingValidator).
 */
const { findDefinition } = require('../metrics');
const store = require('../nayReadStore.service');
const { has, domainPermissionOf } = require('../security');
const { readMaxItems } = require('../nayToolsSettings');

async function loadCauseRecords({ ctx, scope, params, period }, transaction) {
  const max = await readMaxItems(scope, transaction);
  const records = [];
  for (const [metricCode, dimension] of params.causeSources) {
    let definition;
    try { definition = await findDefinition(metricCode, transaction); } catch (err) { if (err.code === 'ANALYTICS_METRIC_NOT_FOUND') continue; throw err; }
    if (!has(ctx, domainPermissionOf(ctx.domainMap, definition.domain))) continue;
    const rows = await store.listDimensionSnapshots({ metricId: definition.id, companyId: scope.companyId, asOfDate: period.asOfDate, dimension, limit: max }, transaction);
    for (const row of rows) {
      const value = row.dimensionKey.slice(dimension.length + 1);
      records.push({
        id: `${metricCode}:${dimension}=${value}`, metricCode, domain: definition.domain, dimension, dimensionValue: value,
        valor: row.value_numeric !== null && row.value_numeric !== undefined ? String(row.value_numeric) : row.value_text,
      });
    }
  }
  return records.slice(0, max);
}

module.exports = { loadCauseRecords };
