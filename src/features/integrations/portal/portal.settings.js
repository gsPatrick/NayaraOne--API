'use strict';

const AppError = require('../../../utils/AppError');

/** Parâmetros dos portais (M9-D232): dicionário de SETTINGS_SCHEMA; a leitura está em portal.params.js. */
const PORTAL_SETTINGS_SCHEMA = Object.freeze({
  // INT-P077: de quantos em quantos minutos o status dos anúncios é lido no portal (fluxo portal.listing_status).
  'integration.portal.reconcile_interval_min': { type: 'integer', min: 1, max: 1440 },
  // Anúncios lidos por página a cada rodada do sync (cursor retomável).
  'integration.portal.sync_page_size': { type: 'integer', min: 5, max: 500 },
  // INT-P078 (M9-D233): minutos sem confirmação da remoção até o job consultar o portal e, se o anúncio segue ativo, reenviar a remoção.
  'integration.portal.unpublish_confirm_deadline_min': { type: 'integer', min: 1, max: 10080 },
  // Minutos entre um reenvio e o próximo (a remoção é idempotente e de baixo custo: sem backoff crescente).
  'integration.portal.unpublish_retry_interval_min': { type: 'integer', min: 1, max: 1440 },
  // Reenvios da remoção antes de desistir e chamar uma pessoa (tarefa urgente e alerta HIGH).
  'integration.portal.unpublish_max_attempts': { type: 'integer', min: 1, max: 50 },
  // M9-D227: papel que recebe a tarefa do anúncio pendente no portal há mais que o prazo da fila (padrão "Gerente de Marketing"; sem ninguém ativo no papel, vale o papel das tarefas da contingência).
  'integration.portal.manual_task_assignee_role': { type: 'string', validate: (key, value) => { if (typeof value !== 'string' || !value.trim() || value.length > 80) throw AppError.badRequest(`O valor de "${key}" deve ser o nome de um papel (até 80 caracteres).`, 'SETTING_INVALID_VALUE', { key, value }); } },
});

module.exports = { PORTAL_SETTINGS_SCHEMA };
