'use strict';

const { sequelize } = require('../../../models');
const logger = require('../../../utils/logger');
const suspension = require('./suspension.reader');
const sink = require('./signals.sink');
const userState = require('./userState.repository');
const { recordSignal } = require('./anomaly.service');

/** Leitor da suspensão (encaixe de M9-D821 etapa 2b): o `dlp_restricted_until` do usuário na empresa, ou null. */
async function readRestrictedUntil(tenant, userId, transaction) {
  const state = await userState.findOne(tenant.companyId, userId, transaction);
  return state && state.restrictedUntil ? new Date(state.restrictedUntil) : null;
}

/**
 * Destino do access_signal (encaixe de M9-D821 §3.1b). Falha segura (M9-D824 §6): o registro e a detecção rodam num savepoint; se falharem, a decisão de RESTRICTED
 * sobe o erro (a ação segue bloqueada) e a dos demais segue liberada com alerta no log.
 */
async function recordWithFailSafe(tenant, signal, transaction) {
  try {
    await sequelize.transaction({ transaction }, (savepoint) => recordSignal(tenant, signal, savepoint));
  } catch (error) {
    logger.error({ err: error, classification: signal.classification, action: signal.action, companyId: tenant.companyId }, 'dlp: falha ao registrar o sinal de acesso ou avaliar a anomalia');
    if (signal.classification === 'RESTRICTED') throw error;
  }
}

/** Liga o leitor e o destino reais nos encaixes do guard. Idempotente; os testes chamam depois de resetReader/resetSignalSink. */
function install() {
  suspension.setReader(readRestrictedUntil);
  sink.setSignalSink(recordWithFailSafe);
}

module.exports = { install, readRestrictedUntil, recordWithFailSafe };
