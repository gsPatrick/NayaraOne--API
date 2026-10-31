'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { openTenantTx } = require('../../core-governance/data-quality/retention.tenantTx');
const connectors = require('../ingest/connectors');
const sources = require('../ingest/source.repository');
const errors = require('./dry.errors');

/** Linhas da origem hoje: `countRows()` do conector (`SELECT count(*)`) ou, na falta, o tamanho da lista de chaves. */
async function originCount(source) {
  const connector = await connectors.open(source);
  try {
    if (typeof connector.countRows === 'function') return Number(await connector.countRows());
    return (await connector.listKeys()).length;
  } finally {
    await connector.close();
  }
}

/** Linhas que a migração deixou no destino por fonte: registros MIGRATED ou RECONCILED que a origem ainda tem. */
async function destinationCount(tenant, source, transaction) {
  const [row] = await sequelize.query(
    `SELECT count(*)::int AS n FROM governance.mig_records WHERE company_id = :companyId AND source_system = :system AND entity = :entity AND state IN ('MIGRATED', 'RECONCILED') AND NOT source_deleted`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, system: source.source_system, entity: source.entity } }
  );
  return row.n;
}

/** Contagem por entidade, origem x destino (M9-D908 §3.3.1). Devolve { volumes[], equal }; `equal` falso é o GOV_MIG_VOLUME_MISMATCH do relatório. */
async function countVolumes(tenant) {
  const list = await openTenantTx(tenant, (transaction) => sources.list(tenant, {}, transaction));
  const volumes = [];
  for (const source of list) {
     
    const origin = await originCount(source);
     
    const destination = await openTenantTx(tenant, (transaction) => destinationCount(tenant, source, transaction));
    volumes.push({ sourceSystem: source.source_system, entity: source.entity, origin, destination, difference: origin - destination, equal: origin === destination });
  }
  return { volumes, equal: volumes.every((item) => item.equal) };
}

/** Sobe GOV_MIG_VOLUME_MISMATCH quando alguma entidade não confere. */
function assertVolumesMatch(volumes) {
  const wrong = volumes.filter((item) => !item.equal);
  if (wrong.length) throw errors.volumeMismatch({ entities: wrong.map(({ sourceSystem, entity, origin, destination }) => ({ sourceSystem, entity, origin, destination })) });
}

module.exports = { countVolumes, assertVolumesMatch, originCount, destinationCount };
