'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { startOfDay, endOfDayExclusive } = require('../days');

const DAY = "(period_start AT TIME ZONE 'America/Sao_Paulo')::date";

/** Texto numérico do Postgres (numeric, 6 casas) -> BigInt na escala 1e6, sem limite de dígitos. */
const scaledOf = (text) => { const [i, f = ''] = String(text || '0').split('.'); return BigInt(i || '0') * 1000000n + BigInt(f.padEnd(6, '0').slice(0, 6)); };

const shiftDay = (key, delta) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
};

/**
 * Volume por dia lido do ledger (M9-D862): soma de `usage_quantity` das linhas ESTIMATED de uma categoria e unidade, no ambiente da instalação, de `fromDay`
 * a `toDay`. Conta também a linha que a fatura substituiu (a quantidade medida não muda quando o preço vira fatura). Devolve Map 'AAAA-MM-DD' -> BigInt (escala 1e6).
 */
async function dailyVolumes(tenant, { category, unit, service, environment }, fromDay, toDay, transaction) {
  const rows = await sequelize.query(
    `SELECT ${DAY}::text AS day, SUM(usage_quantity)::text AS quantity FROM governance.cost_ledger
      WHERE group_id = :groupId AND (company_id IS NULL OR company_id = :companyId) AND category = :category AND usage_unit = :unit AND cost_kind = 'ESTIMATED'
        AND environment = :environment AND (CAST(:service AS text) IS NULL OR service = :service) AND period_start >= :start AND period_start < :end
      GROUP BY 1`,
    { type: QueryTypes.SELECT, transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, category, unit, service: service || null, environment, start: startOfDay(fromDay), end: endOfDayExclusive(toDay) } }
  );
  return new Map(rows.map((r) => [r.day, scaledOf(r.quantity)]));
}

/** Volume do dia e histórico dos `days` dias anteriores que têm medição. */
async function dayAndHistory(tenant, spec, day, days, transaction) {
  const map = await dailyVolumes(tenant, spec, shiftDay(day, -days), day, transaction);
  const history = [];
  for (let i = 1; i <= days; i += 1) { const v = map.get(shiftDay(day, -i)); if (v !== undefined) history.push(v); }
  return { today: map.get(day), history };
}

module.exports = { dailyVolumes, dayAndHistory, shiftDay, scaledOf };
