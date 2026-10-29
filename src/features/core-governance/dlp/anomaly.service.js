'use strict';

const { getSetting } = require('../../settings/settings.service');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const settings = require('./anomaly.settings');
const signals = require('./signals.repository');
const anomalies = require('./anomaly.repository');
const userState = require('./userState.repository');
const { detect } = require('./anomaly.detector');
const { toRow } = require('./anomaly.signal');
const { notifyDlpAdmins } = require('./anomaly.notify');

const read = (key, tenant, transaction) => getSetting(key, tenant, transaction, settings.ANOMALY_SETTING_DEFAULTS[key]);
const plusHours = (date, hours) => new Date(date.getTime() + hours * 3600 * 1000);
const KIND_LABEL = Object.freeze({ READ: 'leitura em massa de dados sensíveis', EXPORT: 'exportações em massa' });

/** Abre a anomalia e aplica a resposta pelo IAM (M9-D824 §3.3 itens 1 e 2): suspensão de EXPORT/SHARE/PRINT, MFA novo, aviso e auditoria. */
async function openAnomaly(tenant, userId, found, at, transaction) {
  const suspensionHours = settings.parseHours(await read(settings.SUSPENSION_HOURS_KEY, tenant, transaction), settings.SUSPENSION_HOURS_KEY);
  const mfaHours = settings.parseHours(await read(settings.MFA_HOURS_KEY, tenant, transaction), settings.MFA_HOURS_KEY);
  const anomaly = await anomalies.insertOpen(tenant, {
    userId, kind: found.kind, windowMinutes: found.windowMinutes, triggerSignals: found.trigger, detectedAt: at, restrictedUntil: plusHours(at, suspensionHours),
    mfaForcedSince: at, mfaForcedUntil: plusHours(at, mfaHours),
  }, transaction);
  if (!anomaly) return null;
  await userState.recompute(tenant, userId, transaction);
  await notifyDlpAdmins(tenant, 'Acesso em massa detectado', `Foi detectada ${KIND_LABEL[found.kind]} por um usuário (${found.trigger.total} itens em ${found.windowMinutes} minutos). Exportar, compartilhar e imprimir ficam suspensos até a revisão em Governança > Proteção contra vazamento.`, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: 'governance.dlp.anomaly.opened', entityType: 'AccessAnomaly', entityId: anomaly.id,
    beforeJson: null, afterJson: { userId, kind: found.kind, trigger: found.trigger, restrictedUntil: anomaly.restrictedUntil, mfaForcedUntil: anomaly.mfaForcedUntil }, reason: `Anomalia de acesso em massa aberta (${KIND_LABEL[found.kind]}).`,
  }, transaction);
  return anomaly;
}

/**
 * Registra o sinal e avalia a detecção de forma síncrona, na transação da decisão (M9-D824 §3.1 e §3.3). Devolve a anomalia aberta ou null. O usuário é travado
 * (advisory lock) para a soma enxergar os sinais das decisões simultâneas.
 */
async function recordSignal(tenant, guardSignal, transaction) {
  const row = toRow(guardSignal);
  if (!row) return null;
  await signals.lockUser(tenant, row.userId, transaction);
  await signals.insert(tenant, row, transaction);
  const thresholds = settings.parseThresholds(await read(settings.THRESHOLDS_KEY, tenant, transaction));
  const found = await detect(tenant, row, thresholds, transaction);
  return found ? openAnomaly(tenant, row.userId, found, new Date(row.occurredAt), transaction) : null;
}

module.exports = { recordSignal, openAnomaly };
