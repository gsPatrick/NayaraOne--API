'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { openTenantTx } = require('../../core-governance/data-quality/retention.tenantTx');
const { notify } = require('../../core-governance/calendar/alerts/alerts.log');
const { findCompanyUser, activeUserIdsWithRole, activeAdminIds } = require('../../core-governance/governance.users');
const { getSetting } = require('../../settings/settings.service');
const logger = require('../../../utils/logger');
const raci = require('../raci/raci.service');
const windows = require('../parallel/window.repository');
const { KEYS, DRY_SETTING_DEFAULTS } = require('../dryrun/dry.settings');

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVITY = 'PARALLEL_COMPARE_CLOSE';
const ALERT_TYPE = 'PARALLEL_WINDOW_OVERDUE';

/** Destinatários: quem é A da atividade PARALLEL_COMPARE_CLOSE (usuário ativo ou os ativos do perfil); sem A utilizável, os administradores ativos da empresa. */
async function accountableRecipients(tenant, transaction) {
  const matrix = await raci.getMatrix(tenant, transaction);
  const entries = ((matrix.activities.find((activity) => activity.code === ACTIVITY) || {}).entries || []).filter((entry) => entry.raci === 'A');
  const ids = new Set();
  for (const entry of entries) {
    if (entry.userId) {
       
      if ((await findCompanyUser(entry.userId, tenant, transaction)).active) ids.add(entry.userId);
    } else {
       
      for (const id of await activeUserIdsWithRole(entry.role, tenant, transaction)) ids.add(id);
    }
  }
  return ids.size ? [...ids] : activeAdminIds(tenant, transaction);
}

/** Reserva a chave do alerta (UNIQUE por empresa): true só para quem reservou primeiro. */
async function claim(tenant, { key, windowId, recipients }, transaction) {
  const rows = await sequelize.query(
    `INSERT INTO governance.mig_alert_log (group_id, company_id, alert_key, alert_type, window_id, recipients) VALUES (:groupId, :companyId, :key, :type, :windowId, :recipients)
     ON CONFLICT (company_id, alert_key) DO NOTHING RETURNING id`,
    { type: QueryTypes.SELECT, transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, key, type: ALERT_TYPE, windowId, recipients } }
  );
  return rows.length > 0;
}

const dayKey = (now) => now.toISOString().slice(0, 10);

/**
 * Janela de comparação paralela ainda RUNNING além do `ends_at` por mais de `migracao.paralelo.prazo_dias` (M9-D908 §3.5.1, regra vinda da M9-D903): alerta CRÍTICO ao A da atividade
 * PARALLEL_COMPARE_CLOSE da RACI (M9-D902), uma vez por janela e por dia. Devolve [{ windowId, recipients }] das janelas avisadas agora. `now` é injetável (testes).
 */
async function alertOverdueWindows(tenant, { now = new Date() } = {}) {
  return openTenantTx(tenant, async (transaction) => {
    const days = Number(await getSetting(KEYS.OVERDUE_DAYS, tenant, transaction, DRY_SETTING_DEFAULTS[KEYS.OVERDUE_DAYS]));
    const sent = [];
    for (const window of await windows.listRunning(tenant, transaction)) {
      const late = Math.floor((now - new Date(window.ends_at)) / DAY_MS);
      if (late <= days) continue;
       
      const recipients = await accountableRecipients(tenant, transaction);
      if (!recipients.length) { logger.warn({ windowId: window.id }, 'migration.parallel.overdue.no_recipient'); continue; } // sem ninguém a avisar não se reserva o alerta: a próxima volta tenta de novo
       
      if (!await claim(tenant, { key: `parallel.overdue:${window.id}:${dayKey(now)}`, windowId: window.id, recipients: recipients.length }, transaction)) continue;
       
      await notify(tenant, recipients, {
        title: 'CRÍTICO: janela de comparação paralela vencida',
        body: `A janela de comparação${window.name ? ` "${window.name}"` : ''} (sistema ${window.source_system}) passou do fim previsto em ${late} dias e ainda está aberta. Feche as diferenças ou decida o encerramento (atividade ${ACTIVITY}).`,
      }, transaction);
      sent.push({ windowId: window.id, recipients });
    }
    return sent;
  });
}

module.exports = { alertOverdueWindows, accountableRecipients, ACTIVITY, ALERT_TYPE };
