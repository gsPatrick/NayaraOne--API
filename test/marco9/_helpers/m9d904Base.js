'use strict';

// Apoio dos testes M9-D904 (não é teste): comparação paralela limpa das entidades que a migração real carrega (PERSON, SUPPLIER, PROPERTY). O gate do avanço considera
// essas entidades em todos os setores; os testes que não tratam delas põem esta janela fechada e concluída para que só o cenário do teste pese.
const env = require('./m9d903Env');
const targets = require('../../../src/features/migration-v2/ingest/targets');

const BASE_NAME = 'QA-M9 D904 base real';

/** Cria (uma vez) a janela CLOSED com uma execução COMPLETED que cobre todas as entidades com destino real. Devolve o id da janela. */
async function ensureCleanBase(tenant) {
  const found = await env.adminQuery('SELECT id FROM governance.parallel_windows WHERE company_id = $1 AND name = $2', [tenant.companyId, BASE_NAME]);
  if (found.rows.length) return found.rows[0].id;
  const created = await env.adminQuery(
    `INSERT INTO governance.parallel_windows (group_id, company_id, name, source_system, starts_at, ends_at, entities, interval_min, status, closed_at)
     VALUES ($1, $2, $3, 'qa-m9d904-base', now() - interval '2 hours', now() - interval '1 hour', $4::jsonb, 60, 'CLOSED', now()) RETURNING id`,
    [tenant.groupId, tenant.companyId, BASE_NAME, JSON.stringify(['PERSON', 'SUPPLIER', 'PROPERTY'].filter((name) => targets.ENTITIES().includes(name)))]
  );
  await env.adminQuery(
    "INSERT INTO governance.parallel_runs (group_id, company_id, window_id, run_number, status, started_at, finished_at) VALUES ($1, $2, $3, 1, 'COMPLETED', now(), now())",
    [tenant.groupId, tenant.companyId, created.rows[0].id]
  );
  return created.rows[0].id;
}

const removeBase = (tenant) => env.adminQuery('DELETE FROM governance.parallel_windows WHERE company_id = $1 AND name = $2', [tenant.companyId, BASE_NAME]);

module.exports = { ensureCleanBase, removeBase, BASE_NAME };
