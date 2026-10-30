'use strict';

const { dateKeyInZone } = require('../../calendar/sources/time');

/**
 * Relatório de CI das flags declaradas (M9-D871 §3.3): flag temporária com validade vencida reprova (GOV_FLAG_EXPIRED) e temporária sem validade também (GOV_FLAG_EXPIRY_REQUIRED).
 * A data é a do calendário de Brasília. Devolve { ok, checkedAt, checked, expired: [...], missingExpiry: [...] }.
 */
function evaluateRegistry(registry, now = new Date()) {
  const expired = [];
  const missingExpiry = [];
  for (const flag of registry.flags) {
    if (!flag.temporary) continue;
    if (!flag.validUntil) { missingExpiry.push({ key: flag.key, code: 'GOV_FLAG_EXPIRY_REQUIRED', message: 'Flag temporária precisa de data de expiração.' }); continue; }
    if (new Date(flag.validUntil).getTime() < now.getTime()) {
      const date = dateKeyInZone(flag.validUntil);
      expired.push({ key: flag.key, owner: flag.owner || null, validUntil: date, code: 'GOV_FLAG_EXPIRED', message: `Flag vencida: ${flag.key} (${date}).` });
    }
  }
  return { ok: expired.length === 0 && missingExpiry.length === 0, checkedAt: now.toISOString(), checked: registry.flags.length, expired, missingExpiry };
}

module.exports = { evaluateRegistry };
