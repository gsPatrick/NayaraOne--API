'use strict';

const { getSetting } = require('../../settings/settings.service');
const policyService = require('./retention.policy.service');
const { runDryRun } = require('./retention.dryrun.service');
const { applyRun } = require('./retention.apply.service');
const { impactOf } = require('./retention.impact');
const runRepository = require('./retention.run.repository');
const { KEYS, RETENTION_SETTING_DEFAULTS } = require('./retention.settings');
const { parsePagination } = require('../api-governance/standards/pagination.helper');
const errors = require('./retention.errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function paging(tenant, query, transaction) {
  return parsePagination(query, tenant, transaction, await getSetting(KEYS.PAGINA, tenant, transaction, RETENTION_SETTING_DEFAULTS[KEYS.PAGINA]));
}

async function listRuns(tenant, query, transaction) {
  const page = await paging(tenant, query, transaction);
  const { rows, total } = await runRepository.listRuns(tenant, page, transaction);
  return { items: rows.map(({ report, ...run }) => ({ ...run, totals: report.totals || null })), page: page.page, pageSize: page.pageSize, total };
}

/** O relatório completo da rodada e, se pedido (`state`), os itens do conjunto com o estado. */
async function getRun(tenant, runId, query, transaction) {
  const run = UUID.test(String(runId)) ? await runRepository.getRun(tenant, runId, transaction) : null;
  if (!run) throw errors.runNotFound();
  const page = await paging(tenant, query, transaction);
  const items = await runRepository.listItems(run.id, { state: query.state || null, limit: page.limit, offset: page.offset }, transaction);
  return { run, items: items.rows, itemsTotal: items.total, page: page.page, pageSize: page.pageSize };
}

module.exports = { listPolicies: policyService.listPolicies, putPolicy: policyService.putPolicy, ensurePolicies: policyService.ensurePolicies, runDryRun, applyRun, impactOf, listRuns, getRun };
