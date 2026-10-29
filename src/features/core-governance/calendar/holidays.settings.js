'use strict';

const { ISO_DATE } = require('./businessDays');

/**
 * Parâmetro dos feriados (M9-D833 §3.3), na aba Governança de /painel/configuracoes. `governanca.calendario.feriados`: datas ISO (AAAA-MM-DD) separadas por vírgula; vazio =
 * feriados nacionais do ano. Lido pelo prazo de conciliação do pagamento emergencial do BCP.
 */
const HOLIDAYS_KEY = 'governanca.calendario.feriados';
const HOLIDAYS_DEFAULTS = Object.freeze({ [HOLIDAYS_KEY]: '' });

function validateHolidays(key, value) {
  const { govError } = require('../governance.errors');
  const items = String(value).split(/[\s,;]+/).filter(Boolean);
  const bad = items.find((item) => !ISO_DATE.test(item) || Number.isNaN(Date.parse(`${item}T00:00:00Z`)) || new Date(`${item}T00:00:00Z`).toISOString().slice(0, 10) !== item);
  if (bad) throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve listar datas AAAA-MM-DD separadas por vírgula (inválida: ${bad}).`, { key });
}

const HOLIDAYS_SCHEMA = { [HOLIDAYS_KEY]: { type: 'string', validate: validateHolidays } };

module.exports = { HOLIDAYS_KEY, HOLIDAYS_DEFAULTS, HOLIDAYS_SCHEMA };
