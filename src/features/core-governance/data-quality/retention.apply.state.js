'use strict';

const { getSetting } = require('../../settings/settings.service');
const { KEYS, RETENTION_SETTING_DEFAULTS } = require('./retention.settings');
const { RUN_STATUS } = require('./retention.constants');
const errors = require('./retention.errors');

const HOUR = 3600 * 1000;
const MINUTE = 60 * 1000;
const read = (tenant, tx, key) => getSetting(key, tenant, tx, RETENTION_SETTING_DEFAULTS[key]);

/**
 * Estado que a rodada precisa ter para o apply começar ou retomar (M9-D911 §3.3.3 e §6):
 *  - sem rodada (ou de outra empresa), ou simulação mais velha que governanca.retencao.dry_run_validade_horas: 409 GOV_RETENTION_DRY_RUN_REQUIRED;
 *  - já aplicada: 409 GOV_RETENTION_ALREADY_APPLIED; sendo aplicada agora (sem sinal de vida há mais que governanca.retencao.apply_timeout_min): 409 GOV_RETENTION_RUN_IN_PROGRESS;
 *  - FAILED (ou APPLYING abandonada) retoma sem revalidar a idade da simulação: os lotes concluídos não se repetem.
 * Devolve 'FRESH' ou 'RESUME'.
 */
async function assertApplicable(tenant, run, transaction, now = new Date()) {
  if (!run) throw errors.dryRunRequired();
  if (run.status === RUN_STATUS.APPLIED) throw errors.alreadyApplied();
  if (run.status === RUN_STATUS.APPLYING) {
    const timeout = Number(await read(tenant, transaction, KEYS.APPLY_TIMEOUT_MIN)) * MINUTE;
    if (now.getTime() - new Date(run.updatedAt).getTime() < timeout) throw errors.inProgress();
    return 'RESUME';
  }
  if (run.status === RUN_STATUS.FAILED) return 'RESUME';
  const validity = Number(await read(tenant, transaction, KEYS.VALIDADE_HORAS)) * HOUR;
  if (now.getTime() - new Date(run.createdAt).getTime() > validity) throw errors.dryRunRequired();
  return 'FRESH';
}

module.exports = { assertApplicable };
