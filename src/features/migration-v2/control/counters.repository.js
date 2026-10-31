'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/**
 * Contadores materializados lado a lado com a contagem direta, por (sistema, entidade, estado), numa ÚNICA instrução (um só instantâneo: escritas concorrentes não geram
 * divergência falsa). `counter` vem de governance.mig_counters; `live` é count(*) de governance.mig_records.
 */
function readSideBySide(tenant, transaction) {
  return sequelize.query(
    `WITH c AS (SELECT source_system, entity, state, n FROM governance.mig_counters WHERE company_id = :companyId),
          l AS (SELECT source_system, entity, state, count(*)::bigint AS n FROM governance.mig_records WHERE company_id = :companyId GROUP BY source_system, entity, state)
     SELECT COALESCE(c.source_system, l.source_system) AS source_system, COALESCE(c.entity, l.entity) AS entity, COALESCE(c.state, l.state) AS state,
            COALESCE(c.n, 0)::bigint AS counter, COALESCE(l.n, 0)::bigint AS live
       FROM c FULL JOIN l ON c.source_system = l.source_system AND c.entity = l.entity AND c.state = l.state
      ORDER BY 1, 2, 3`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId } }
  );
}

/** Refaz os contadores a partir dos registros (segura os escritores com um lock de tabela; só roda quando já se sabe que há divergência). Devolve quantas linhas mudou. */
async function rebuild(tenant, transaction) {
  await sequelize.query('LOCK TABLE governance.mig_records IN SHARE MODE', { transaction });
  const rows = await readSideBySide(tenant, transaction);
  let corrected = 0;
  for (const row of rows) {
    if (Number(row.counter) === Number(row.live)) continue;
     
    await sequelize.query(
      `INSERT INTO governance.mig_counters AS c (group_id, company_id, source_system, entity, state, n) VALUES (:groupId, :companyId, :system, :entity, :state, :n)
       ON CONFLICT (company_id, source_system, entity, state) DO UPDATE SET n = EXCLUDED.n, updated_at = now()`,
      { transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, system: row.source_system, entity: row.entity, state: row.state, n: row.live } }
    );
    corrected += 1;
  }
  return corrected;
}

module.exports = { readSideBySide, rebuild };
