'use strict';

const AppError = require('../../utils/AppError');

/**
 * `governanca.ui.exibir_debug` (M9-D852 §3.2 item 3): liga o campo `debug` no corpo do erro 500, só fora de produção. Em produção
 * o valor `true` é recusado ao gravar e ignorado ao ler (defesa dupla: nunca há stack no corpo em produção).
 */
const isProduction = () => process.env.NODE_ENV === 'production';

function assertDebugAllowed(key, value) {
  if (value === true && isProduction()) throw AppError.badRequest('O modo debug do erro é proibido em produção.', 'SETTING_INVALID_VALUE', { key });
}

/** Corpo `debug` do erro 500 (mensagem e stack em campo separado) ou undefined. */
function debugBody(err, enabled) {
  if (!enabled || isProduction() || !err) return undefined;
  return { message: String(err.message || ''), stack: String(err.stack || '') };
}

module.exports = { assertDebugAllowed, debugBody, isProduction };
