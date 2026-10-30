'use strict';

const { startOfDay, endOfDayExclusive } = require('../days');
const { dayKey } = require('../costReadModel');
const { readFinopsParams } = require('../finops.params');
const { divHalfEven, safeNumber } = require('../money');
const { bytesToGb } = require('../accrual.service');
const ledger = require('../ledger.service');
const measure = require('./storage.measure');

/** Dia anterior (AAAA-MM-DD) ao dado. */
function previousDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}
const daysInMonth = (key) => { const [y, m] = key.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

/**
 * Coletor de storage (M9-D860 §3.2), job diário (hora em `governanca.finops.storage_hora`, padrão 02:00 de Brasília): mede o DIA ANTERIOR fechado.
 * ESTIMATED do dia = bytes x preço por GB-mês / dias do mês, arredondado half-even no fechamento do dia (120 GB a R$ 0,10, outubro: 38,71 = 39 centavos).
 * O preço vem de `storage_gb_mes` (arquivos e bucket) ou `logs_gb_mes` (logs, `usage_quantity` em GB: fonte da M9-D862). `measurements` permite injetar a medição.
 */
async function collectStorage(tenant, now, transaction, { measurements } = {}) {
  const params = await readFinopsParams(tenant, transaction);
  const day = previousDay(dayKey(now));
  const start = startOfDay(day);
  const end = endOfDayExclusive(day);
  const items = measurements || await measure.measureAll(tenant, day, transaction);
  const lines = [];
  for (const item of items) {
    const price = params.prices[item.unit === 'logs' ? 'logs_gb_mes' : 'storage_gb_mes'];
    if (price === undefined) continue;
    const cents = divHalfEven(item.bytes * price, params.gbBase ** 3n * BigInt(daysInMonth(day)) * 1000000n);
    lines.push({
      companyId: item.companyId, category: 'STORAGE', service: item.service, domain: 'PLATFORM', costKind: 'ESTIMATED', lineType: 'CHARGE', usageQuantity: bytesToGb(item.bytes, params.gbBase),
      usageUnit: 'GB', amountCents: safeNumber(cents), periodStart: start, periodEnd: end, sourceRef: `storage:${item.service}:${day}`,
    });
  }
  if (lines.length) await ledger.recordLines(tenant, lines, transaction);
  return lines.length;
}

module.exports = { collectStorage, previousDay, daysInMonth };
