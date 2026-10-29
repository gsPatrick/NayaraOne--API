'use strict';

const logger = require('../../utils/logger');
const { generateExport } = require('../../features/core-governance/dlp/exports/export.run');
const repo = require('../../features/core-governance/dlp/exports/export.repository');
const { runForEachCompany } = require('./calendarJobRunner');

/**
 * exportGenerationJob (M9-D822 §3.2) — recolhe os pedidos APPROVED que ficaram sem gerar (a geração normal dispara logo depois do pedido; este job cobre processo que caiu
 * entre uma coisa e outra). O claim APPROVED -> GENERATING é atômico: dois processos nunca geram o mesmo arquivo. Desligar no processo: DLP_EXPORT_GENERATION_JOB_DISABLED=true.
 */
const TICK_MS = 30 * 1000;
const LIMIT = 20;

async function runExportGenerationJob() {
  const pending = [];
  await runForEachCompany('exportGenerationJob', async (tenant, transaction) => {
    const rows = await repo.listApproved(tenant.companyId, LIMIT, transaction);
    pending.push(...rows.map((row) => ({ tenant, id: row.id })));
    return rows.length ? { found: rows.length } : null;
  }, 'dlp');
  for (const item of pending) await generateExport(item.tenant, item.id);
  return pending.length;
}

function startExportGenerationJob({ intervalMs = TICK_MS } = {}) {
  const tick = () => runExportGenerationJob().catch((err) => logger.error({ err: err.message }, 'exportGenerationJob.failed'));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runExportGenerationJob, startExportGenerationJob };
