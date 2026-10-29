'use strict';

/**
 * M9-D611 (3.1, 3.4, 3.5) — monta o `sourceRefs` de uma métrica: [{ type, table, filterHash, filterSignature, filter, count, idsSample,
 * description, restricted, reconcileMode }]. `filterHash` é o SHA-256 do filtro canônico, assinado com HMAC (3.6). Sem permissão de
 * detalhe, `count` e `filterHash` continuam visíveis, `idsSample` vem vazio e `restricted=true`. KPI composto devolve `components[]`
 * (cada componente com os seus sourceRefs) e na lista principal a união deles.
 */
const { sequelize } = require('../../../models');
const { P, has, loadDomainMap, domainPermissionOf } = require('../security');
const { getSourceSpec } = require('./sourceRefs.spec');
const { normalizeFilter, hashFilter, signFilterHash } = require('./sourceRefs.filter');
const { countRows, sampleIds } = require('./sourceRefs.query');
const { reconcileModeForUnit } = require('./sourceRefs.mode');
const { readSampleSize } = require('./sourceRefs.settings');
const { sourceSpecMissing } = require('./sourceRefs.errors');

const DOMAIN_BY_PREFIX = {
  fin: 'FINANCE', crm: 'CRM', radar: 'CRM', prop: 'PROPERTIES', rent: 'RENTAL', obra: 'CONSTRUCTION', inv: 'INVENTORY',
  legal: 'LEGAL', cor: 'CORRESPONDENT', mkt: 'MARKETING', sup: 'SUPPORT', tec: 'TECH_AI',
};

/** Unidade e domínio da métrica publicada; sem definição publicada usa o que o chamador informar (domínio pelo prefixo do código). */
async function metricContext(metricCode, options, transaction) {
  const [rows] = await sequelize.query(
    `SELECT d.domain, v.unit FROM analytics.metric_definitions d LEFT JOIN analytics.metric_versions v ON v.id = d.current_version_id
      WHERE d.metric_code = :code ORDER BY (d.company_id IS NULL), (d.group_id IS NULL) LIMIT 1`,
    { replacements: { code: metricCode }, transaction }
  );
  const unit = (rows[0] && rows[0].unit) || options.unit;
  const domain = (rows[0] && rows[0].domain) || options.domain || DOMAIN_BY_PREFIX[metricCode.split('.')[0]];
  return { unit, domain };
}

function modeOf(spec, unit) {
  return unit === 'BRL_PER_UNIT' && spec.reconcileMode ? spec.reconcileMode : reconcileModeForUnit(unit);
}

/** Pode ver ids: permissão de detalhe do BI E permissão de leitura da área de origem (ABAC da M9-D700). */
async function detailAllowed(ctx, domain, transaction) {
  if (!has(ctx, P.DRILLDOWN)) return false;
  return has(ctx, domainPermissionOf(await loadDomainMap(ctx, transaction), domain));
}

async function buildLeafRef(ctx, spec, rawFilter, { mode, allowed, sampleSize }, transaction) {
  const filter = normalizeFilter({ ...rawFilter, companyId: ctx.companyId });
  const filterHash = hashFilter(spec.table, filter);
  const count = await countRows(spec, filter, transaction);
  return {
    type: spec.type, table: spec.table, filter, filterHash, filterSignature: await signFilterHash(ctx.companyId, filterHash), count,
    idsSample: allowed ? await sampleIds(spec, filter, sampleSize, transaction) : [], description: spec.describe(filter),
    restricted: !allowed, reconcileMode: mode,
  };
}

/**
 * options: { filter } (folha) ou { componentFilters: { codigoDoComponente: filtro } } (composto); { unit, units: { codigo: unidade }, domain }
 * só quando a métrica ainda não está publicada. Devolve { metricCode, reconcileMode, sourceRefs, components? }.
 */
async function buildSourceRefs(ctx, metricCode, options, transaction) {
  const spec = getSourceSpec(metricCode);
  if (!spec) throw sourceSpecMissing(metricCode);
  const opts = options || {};
  const { unit, domain } = await metricContext(metricCode, { unit: (opts.units || {})[metricCode] || opts.unit, domain: opts.domain }, transaction);
  const mode = spec.components ? null : modeOf(spec, unit);
  if (spec.components) {
    const components = [];
    for (const code of spec.components) {
      const sub = await buildSourceRefs(ctx, code, { ...opts, filter: (opts.componentFilters || {})[code], unit: undefined, domain: undefined }, transaction);
      components.push({ metricCode: code, reconcileMode: sub.reconcileMode, sourceRefs: sub.sourceRefs, ...(sub.components ? { components: sub.components } : {}) });
    }
    return { metricCode, reconcileMode: 'COMPOSITE', sourceRefs: components.flatMap((c) => c.sourceRefs), components };
  }
  const allowed = await detailAllowed(ctx, domain, transaction);
  const sampleSize = await readSampleSize(ctx, transaction);
  const ref = await buildLeafRef(ctx, spec, opts.filter, { mode, allowed, sampleSize }, transaction);
  return { metricCode, reconcileMode: mode, sourceRefs: [ref] };
}

module.exports = { buildSourceRefs, detailAllowed, metricContext, modeOf };
