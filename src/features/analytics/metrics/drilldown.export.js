'use strict';

/**
 * M9-D701 (3.3) — as linhas-fonte de um filtro assinado para a EXPORTAÇÃO: as mesmas verificações do detalhe (M9-D690: filtro assinado, métrica publicada
 * e crítica ou com detalhe, `analytics:drilldown` e a permissão do domínio) e todas as páginas até `maxRows`, sem mascarar e sem gravar log: quem exporta passa o
 * resultado por `prepareSecureRows` (M9-D700). Mais linhas que o teto não é truncamento silencioso: lança `tooLarge`. Lê só o read model/fonte pelo filtro assinado.
 */
const { getSourceSpec } = require('./sourceRefs.spec');
const { verifyFilter } = require('./sourceRefs.filter');
const { openSourceDetail } = require('./sourceRefs.detail');
const { modeOf, metricContext } = require('./sourceRefs.build');
const { pageRows } = require('./drilldown.rows');
const { findDefinition, sourceCodeOf, parseFilter } = require('./drilldown.service');
const { drilldownNotAvailable, metricNotFound } = require('./drilldown.errors');

const PAGE = 1000;

async function assertExportableDefinition(metricCode, transaction) {
  const definition = await findDefinition(metricCode, transaction);
  if (!definition) throw metricNotFound();
  if (definition.status !== 'PUBLISHED' || !(definition.criticality === 'CRITICAL' || definition.drilldown_enabled)) throw drilldownNotAvailable();
  return definition;
}

/** Confere permissão, filtro e métrica e devolve { definition, sourceCode, count, description, domain } sem ler linha (estimativa e reaplicação de permissão). */
async function inspectDrilldownExport(ctx, input, transaction) {
  const definition = await assertExportableDefinition(input.metricCode, transaction);
  const sourceCode = sourceCodeOf(input);
  const detail = await openSourceDetail(ctx, sourceCode, { ...input, filter: parseFilter(input.filter) }, transaction, { limit: 1, domain: definition.domain });
  return { definition, sourceCode, count: detail.count, description: detail.description, domain: definition.domain };
}

/** { description, count, mode, rows: [{ id, fields, contribution, link }] }. `tooLarge(count, maxRows)` é chamado (e deve lançar) se passar do teto. */
async function loadDrilldownExportRows(ctx, input, transaction, { maxRows, tooLarge }) {
  const info = await inspectDrilldownExport(ctx, input, transaction);
  if (info.count > maxRows) throw tooLarge(info.count, maxRows);
  const spec = getSourceSpec(info.sourceCode);
  const filter = await verifyFilter(ctx.companyId, spec.table, { ...input, filter: parseFilter(input.filter) });
  const { unit } = await metricContext(info.sourceCode, { unit: (await metricContext(input.metricCode, {}, transaction)).unit }, transaction);
  const mode = modeOf(spec, unit);
  const rows = [];
  for (let page = 1; rows.length < info.count; page += 1) {
    const { rows: chunk } = await pageRows(spec, filter, { mode, page, pageSize: PAGE }, transaction);
    if (!chunk.length) break;
    rows.push(...chunk);
  }
  return { description: info.description, count: info.count, mode, rows, domain: info.domain, sourceCode: info.sourceCode };
}

module.exports = { inspectDrilldownExport, loadDrilldownExportRows };
