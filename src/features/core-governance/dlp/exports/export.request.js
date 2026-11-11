'use strict';

const { getSetting } = require('../../../settings/settings.service');
const { hasRecentMfa } = require('../../../users/mfa.service');
const guardService = require('../guard.service');
const { blockedError } = require('../guard.reasons');
const settings = require('../dlp.settings');
const { idempotencyConflict } = require('../dlp.errors');
const { scopedKey } = require('../idempotency.header');
const { sameJson } = require('../canonical');
const { parseExportBody } = require('./export.input');
const { readExportParams } = require('./export.params');
const { inTenant } = require('./export.tx');
const { scheduleGeneration } = require('./export.run');
const repo = require('./export.repository');
const fieldPolicy = require('../../data-quality/fieldAccess.export');

const sameRequest = (job, parsed) => job.resourceType === parsed.entry.code && job.format === parsed.format && job.watermark === parsed.watermark
  && sameJson(job.filter, parsed.filter) && sameJson(job.columns, parsed.columns)
  && (job.purpose || null) === (parsed.purpose ? parsed.purpose.trim().slice(0, 40) : null) && (job.justification || null) === parsed.justification;

async function justificationMin(tenant, transaction) {
  return settings.parseJustificationMin(await getSetting(settings.JUSTIFICATION_MIN_KEY, tenant, transaction, settings.DLP_SETTING_DEFAULTS[settings.JUSTIFICATION_MIN_KEY]));
}

/** Pedido já registrado com a mesma chave: o mesmo corpo devolve o mesmo pedido (sem novo arquivo); outro corpo é 409; bloqueado repete o bloqueio. */
async function answerExisting(tenant, actorUserId, existing, parsed, transaction) {
  if (existing.actorUserId !== actorUserId) throw idempotencyConflict();
  if (existing.format && !sameRequest(existing, parsed)) throw idempotencyConflict();
  let job = existing;
  if (!existing.format) job = (await inTenant(tenant, actorUserId, (tx) => repo.attachRequest(tenant.companyId, existing.id, parsed, tx))) || existing;
  if (job.status === 'BLOCKED') throw blockedError({ blockReason: job.blockReason, job: { id: job.id } }, await justificationMin(tenant, transaction));
  if (job.status === 'APPROVED') scheduleGeneration(tenant, job.id);
  return { exportJobId: job.id, status: job.status, replayed: true };
}

/**
 * POST /exports (M9-D822 §3.1): valida o corpo, estima as linhas, passa pelo guard de DLP (M9-D821: classificação, permissão, finalidade, MFA, volume) e, aprovado,
 * guarda formato, filtro e colunas no pedido e dispara a geração assíncrona. Bloqueado: o pedido fica BLOCKED e o erro do motivo sobe. `transaction` é a da requisição.
 * Devolve { exportJobId, status, replayed }.
 */
async function requestExport({ tenant, actorUserId, body, idempotencyKey, transaction }) {
  const key = scopedKey(actorUserId, idempotencyKey, 'e');
  const params = await readExportParams(tenant, transaction);
  const parsed = parseExportBody(body, params.formats);
  // M9-D915: coluna FORBIDDEN no registro recusa o pedido (se foi listada) ou sai do arquivo com aviso (se o pedido não listou colunas).
  const policy = await fieldPolicy.applyRequestPolicy(tenant, parsed.entry, parsed.columns, parsed.columnsListed, transaction);
  parsed.columns = policy.columns;
  parsed.warnings = policy.warnings;
  const existing = await repo.findByKey(tenant.companyId, key, transaction);
  if (existing) return answerExisting(tenant, actorUserId, existing, parsed, transaction);

  const ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId: actorUserId };
  const estimatedRows = await parsed.entry.estimate(ctx, parsed.filter, transaction);
  const decision = await guardService.decide(tenant, {
    // minClassification: piso de classe declarado pelo recurso do catálogo (ex.: crm.opportunities = HIGH, livro do Marco 3 §18), nunca abaixo do registro.
    action: 'EXPORT', kind: 'EXPORT', resourceType: parsed.entry.code, minClassification: parsed.entry.minClassification, query: { filter: parsed.filter, columns: parsed.columns, format: parsed.format }, purpose: parsed.purpose,
    justification: parsed.justification, estimatedRows, mfaOk: await hasRecentMfa(actorUserId, transaction), originPermission: parsed.entry.permission, watermarkRequested: parsed.watermark,
    idempotencyKey: key, actorUserId,
  });
  if (decision.replayed) return answerExisting(tenant, actorUserId, await repo.findByKey(tenant.companyId, key, transaction), parsed, transaction);
  const job = await inTenant(tenant, actorUserId, (tx) => repo.attachRequest(tenant.companyId, decision.job.id, parsed, tx));
  if (decision.decision === 'DENY') throw blockedError(decision, decision.justificationMin);
  scheduleGeneration(tenant, job.id);
  return { exportJobId: job.id, status: job.status, replayed: false };
}

module.exports = { requestExport };
