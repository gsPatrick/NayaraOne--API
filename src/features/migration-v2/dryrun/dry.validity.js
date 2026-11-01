'use strict';

const { getSetting } = require('../../settings/settings.service');
const { currentCommit } = require('./dry.export');
const { sameCommit } = require('./dry.commit');
const { CRITERIA } = require('./dry.criteria');
const { KEYS, DRY_SETTING_DEFAULTS } = require('./dry.settings');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR_MS = 3600 * 1000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

const read = (tenant, key, transaction) => getSetting(key, tenant, transaction, DRY_SETTING_DEFAULTS[key]);

/**
 * Vínculo do relatório exportado ao GO (M9-D908 reabertura N2). A assinatura prova que o arquivo não foi editado; aqui se prova que ele vale para ESTA empresa e ESTE código, agora: identificador
 * do ensaio, empresa assinada igual à do GO, os seis critérios verdes, 100% dos lotes verificados, volume mínimo (parâmetro), commit igual ao em execução (parâmetro) e idade máxima (parâmetro).
 * Devolve a chave do motivo da recusa (texto em dry.readiness) ou null; `detail` leva os números que ajudam o operador.
 */
async function bindingProblem(report, tenant, transaction, { now = new Date() } = {}) {
  if (typeof report.report_id !== 'string' || !UUID.test(report.report_id)) return { reason: 'NO_REPORT_ID' };
  if (report.company_id !== tenant.companyId) return { reason: 'OTHER_COMPANY' };
  const criteria = report.criteria || {};
  const red = CRITERIA.filter((name) => !criteria[name] || criteria[name].ok !== true);
  if (red.length) return { reason: 'CRITERIA_RED', red };
  const batches = criteria.batches_verified;
  if (!(batches.total > 0 && batches.verified === batches.total)) return { reason: 'BATCHES_PENDING', total: batches.total, verified: batches.verified };
  const minimum = Number(await read(tenant, KEYS.MIN_VOLUME, transaction));
  const rows = Number(criteria.counts_match.rows);
  if (!Number.isFinite(rows) || rows < minimum) return { reason: 'VOLUME_BELOW_MINIMUM', rows: Number.isFinite(rows) ? rows : null, minimum };
  if (await read(tenant, KEYS.SAME_COMMIT, transaction) !== false) {
    if (!sameCommit(report.commit, currentCommit())) return { reason: 'OTHER_COMMIT' };
    if (report.dirty === true) return { reason: 'DIRTY_TREE' };
  }
  const generated = Date.parse(report.generated_at);
  const maxHours = Number(await read(tenant, KEYS.VALIDITY_HOURS, transaction));
  if (Number.isNaN(generated) || generated - now.getTime() > FUTURE_TOLERANCE_MS) return { reason: 'BAD_DATE' };
  if (now.getTime() - generated > maxHours * HOUR_MS) return { reason: 'EXPIRED', maxHours };
  return null;
}

module.exports = { bindingProblem };
