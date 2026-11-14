'use strict';

const AppError = require('../../../../../utils/AppError');

/** Parâmetros do pagamento bancário (M9-D237): dicionário de SETTINGS_SCHEMA; a leitura está em bank.params.js. */
const BANK_SETTINGS_SCHEMA = Object.freeze({
  // Linhas do extrato lidas por página (cursor do fluxo bank.statement).
  'integration.bank.statement_page_size': { type: 'integer', min: 10, max: 500 },
  // Tolerância, em dias, entre a data do lançamento do extrato e a data do envio ao casar por (valor, favorecido, data).
  'integration.bank.reconcile_date_tolerance_days': { type: 'integer', min: 0, max: 30 },
  // Idade mínima, em minutos, de uma intenção SUBMITTING/SUBMITTED para o job consultar o banco.
  'integration.bank.reconcile_min_age_min': { type: 'integer', min: 0, max: 1440 },
  // Ligado (comportamento anterior): status final sem valor informado confirma. Desligado: confirmação sem valor para conferir vira divergência.
  'integration.bank.confirm_without_amount': { type: 'boolean' },
  // M9-D228: papel (financeiro) que recebe a tarefa de conferir no internet banking a ordem pendente além do prazo `integration.bank.max_pending_hours`.
  'integration.bank.manual_task_assignee_role': { type: 'string', validate: (key, value) => { if (typeof value !== 'string' || !value.trim() || value.length > 80) throw AppError.badRequest(`O valor de "${key}" deve ser o nome de um papel (até 80 caracteres).`, 'SETTING_INVALID_VALUE', { key, value }); } },
});

module.exports = { BANK_SETTINGS_SCHEMA };
