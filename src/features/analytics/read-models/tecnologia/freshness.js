'use strict';

/**
 * M9-D628 — rm_tech_freshness: por read model do BI, o limite de idade em minutos (`max_age_minutes`, do domínio de freshness TECH_AI/FINANCE/..., parâmetros
 * analytics.freshness.max_minutos.<DOMINIO>), o instante da última atualização bem-sucedida da fonte (`last_snapshot_at`, o maior source_snapshot_at de
 * analytics.read_model_refreshes) e o estado FRESH, STALE, EXPIRED ou UNKNOWN (M9-D609) pela idade que a fonte tinha QUANDO aquela atualização terminou (finished_at menos source_snapshot_at, independe do relógio da leitura, então o rebuild reproduz o incremental). O KPI refaz a idade no instante da leitura (DI-D628-3).
 * O domínio de cada read model vem do prefixo do nome (tabela fixa abaixo); read model sem prefixo conhecido usa o limite de TECH_AI.
 */
const { select, defineCompanyWideModel, toRow } = require('./common');
const { readFreshnessParams } = require('../../metrics/freshness.settings');
const { classify, ageMinutesBetween } = require('../../metrics/freshness');

const KEY = ['read_model'];
const DOMAIN_BY_PREFIX = Object.freeze([
  ['rm_finance_', 'FINANCE'], ['rm_crm_', 'CRM'], ['rm_radar_', 'CRM'], ['rm_broker_', 'CRM'], ['rm_property_', 'PROPERTIES'], ['rm_rental_', 'RENTAL'],
  ['rm_project_', 'CONSTRUCTION'], ['rm_postwork_', 'CONSTRUCTION'], ['rm_inventory_', 'INVENTORY'], ['rm_tool_', 'INVENTORY'], ['rm_legal_', 'LEGAL'], ['rm_fin_', 'CORRESPONDENT'],
  ['rm_mkt_', 'MARKETING'], ['rm_support_', 'SUPPORT'], ['rm_tech_', 'TECH_AI'], ['rm_ai_', 'TECH_AI'],
]);

const domainOf = (readModel) => (DOMAIN_BY_PREFIX.find(([prefix]) => readModel.startsWith(prefix)) || [null, 'TECH_AI'])[1];

async function build({ companyId, groupId, transaction }) {
  const fresh = await readFreshnessParams({ companyId, groupId }, transaction);
  const refreshed = await select(
    `SELECT DISTINCT ON (read_model) read_model, source_snapshot_at AS last_snapshot_at, finished_at FROM analytics.read_model_refreshes
      WHERE company_id = :companyId AND status IN ('SUCCEEDED', 'DEGRADED') AND read_model <> 'rm_tech_freshness' AND source_snapshot_at IS NOT NULL
      ORDER BY read_model, source_snapshot_at DESC, finished_at DESC`,
    { companyId }, transaction
  );
  return refreshed.map((r) => {
    const domain = domainOf(r.read_model);
    const limit = fresh.overrides[domain] || fresh.limits[domain];
    const state = classify(ageMinutesBetween(r.last_snapshot_at, r.finished_at), limit, fresh.factor); // a idade que a fonte tinha QUANDO a atualização terminou (D609: registro histórico)
    return toRow(KEY)({ read_model: r.read_model, max_age_minutes: limit, last_snapshot_at: r.last_snapshot_at, state });
  });
}

const def = defineCompanyWideModel({ name: 'rm_tech_freshness', keyColumns: KEY, build });

module.exports = { def, build, domainOf };
