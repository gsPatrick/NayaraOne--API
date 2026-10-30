'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

const VERSION_SQL = `f.id AS flow_id, f.code AS flow_code, f.owner_user_id, f.status AS flow_status, v.id AS version_id, v.version_no, v.trigger_type, v.trigger_config,
  v.conditions, v.actions, v.cooldown, v.frequency_cap, v.valid_from, v.valid_until, v.status AS version_status`;

function shape(row) {
  return {
    flow: { id: row.flow_id, code: row.flow_code, ownerUserId: row.owner_user_id, status: row.flow_status },
    version: {
      id: row.version_id, versionNo: row.version_no, triggerType: row.trigger_type, triggerConfig: row.trigger_config || {}, conditions: row.conditions || [], actions: row.actions || [],
      cooldown: row.cooldown, frequencyCap: row.frequency_cap, validFrom: row.valid_from, validUntil: row.valid_until, status: row.version_status,
    },
  };
}

/** Passo 2: fluxos ACTIVE cuja versão PUBLISHED dispara para este evento. Fluxo pausado ou sem versão publicada não entra (nenhuma run). */
async function findCandidates(eventType, transaction) {
  const rows = await run(
    `SELECT ${VERSION_SQL} FROM marketing.automation_flows f
       JOIN marketing.automation_versions v ON v.id = f.published_version_id AND v.company_id = f.company_id
      WHERE f.status = 'ACTIVE' AND f.deleted_at IS NULL AND v.status = 'PUBLISHED' AND v.deleted_at IS NULL
        AND v.trigger_type = 'EVENT' AND v.trigger_config->>'eventType' = :eventType ORDER BY f.created_at, f.id`,
    { eventType }, transaction
  );
  return rows.map(shape);
}

/** Fluxos ACTIVE com gatilho de agenda (tick do runner). */
async function findScheduled(transaction) {
  const rows = await run(
    `SELECT ${VERSION_SQL} FROM marketing.automation_flows f
       JOIN marketing.automation_versions v ON v.id = f.published_version_id AND v.company_id = f.company_id
      WHERE f.status = 'ACTIVE' AND f.deleted_at IS NULL AND v.status = 'PUBLISHED' AND v.deleted_at IS NULL AND v.trigger_type = 'SCHEDULE' ORDER BY f.created_at, f.id`,
    {}, transaction
  );
  return rows.map(shape);
}

/** Fluxo e versão de uma run (qualquer estado da versão: a run guarda a versão que a gerou). */
async function loadForRun(versionId, transaction) {
  const [row] = await run(
    `SELECT ${VERSION_SQL} FROM marketing.automation_versions v JOIN marketing.automation_flows f ON f.id = v.flow_id AND f.company_id = v.company_id WHERE v.id = :versionId`,
    { versionId }, transaction
  );
  return row ? shape(row) : null;
}

module.exports = { findCandidates, findScheduled, loadForRun };
