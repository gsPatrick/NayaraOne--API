'use strict';

const { Op } = require('sequelize');
const { Contract } = require('../../../../models');

/**
 * Contratos a vencer (M9-D035/D038): contratos ATIVOS cuja vigência termina dentro da maior faixa, por faixa EXCLUSIVA em dias (0 a 30, 31 a 60...).
 * `detail=false` devolve só quantidade e valor somado por faixa, sem identificar contrato (Diretoria); `detail=true` acrescenta a lista nominal.
 */
const DAY = 86400000;
const cents = (v) => Math.round((Number(v) || 0) * 100);

async function getExpiringContracts(transaction, { bands, detail, now = new Date() }) {
  const horizon = bands[bands.length - 1];
  const rows = await Contract.findAll({
    where: { status: 'ACTIVE', endsAt: { [Op.gte]: now, [Op.lte]: new Date(now.getTime() + horizon * DAY) } },
    order: [['ends_at', 'ASC']],
    transaction,
  });
  const out = bands.map((to, i) => ({ fromDays: i === 0 ? 0 : bands[i - 1] + 1, toDays: to, count: 0, totalCents: 0 }));
  const contracts = [];
  for (const c of rows) {
    const daysLeft = Math.max(0, Math.ceil((new Date(c.endsAt).getTime() - now.getTime()) / DAY));
    const band = out.find((b) => daysLeft <= b.toDays);
    if (!band) continue;
    band.count += 1;
    band.totalCents += cents(c.totalValue);
    if (detail) contracts.push({ contractId: c.id, contractNumber: c.contractNumber || null, endsAt: new Date(c.endsAt).toISOString(), daysLeft, value: cents(c.totalValue) / 100 });
  }
  return {
    generatedAt: now.toISOString(),
    source: 'legal.contracts',
    mode: detail ? 'DETAIL' : 'SUMMARY',
    bands: out.map((b) => ({ fromDays: b.fromDays, toDays: b.toDays, count: b.count, total: b.totalCents / 100 })),
    ...(detail ? { contracts } : {}),
  };
}

module.exports = { getExpiringContracts };
