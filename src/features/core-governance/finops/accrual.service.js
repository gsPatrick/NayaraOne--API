'use strict';

const { HOUR_MS, PLATFORM_DOMAIN, SCALE } = require('./finops.constants');
const { readFinopsParams } = require('./finops.params');
const { scaledToCents, safeNumber, divHalfEven } = require('./money');
const repo = require('./accrual.repository');
const ledger = require('./ledger.service');

const hourStart = (date) => new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);

/** Registra um uso (IA, mensageria, egress) no acúmulo da hora. `costScaled` = centavos x 1e6 (BigInt). Não grava o ledger: isso é do fechamento da hora. */
async function recordUsage(tenant, { category, service, domain = PLATFORM_DOMAIN, quantity, unit, costScaled, tokensIn = 0, tokensOut = 0, calls = 1, at = new Date() }, transaction) {
  const params = await readFinopsParams(tenant, transaction);
  await repo.addUsage(tenant, {
    environment: params.environment, domain, category, service, hourStart: hourStart(at), quantity: String(quantity), unit, costScaled: costScaled.toString(), tokensIn, tokensOut, calls,
  }, transaction);
}

/** Bytes -> GB (texto com 6 casas) na base configurada. */
function bytesToGb(bytes, gbBase) {
  const scaled = divHalfEven(BigInt(bytes) * 1000000n, gbBase ** 3n);
  return `${scaled / 1000000n}.${String(scaled % 1000000n).padStart(6, '0')}`;
}

/**
 * Fecha as horas encerradas da empresa: UMA linha ESTIMATED por hora, serviço e domínio, com `amount_cents` inteiro arredondado half-even da soma das frações.
 * Idempotente: hora já consolidada só é regravada se recebeu uso depois. `categories` limita o fechamento ao coletor chamado. Devolve o número de linhas.
 */
async function consolidateClosedHours(tenant, now, categories, transaction) {
  const params = await readFinopsParams(tenant, transaction);
  const rows = await repo.listClosable(tenant, now, categories, transaction);
  if (!rows.length) return 0;
  const lines = rows.map((r) => {
    const start = new Date(r.hour_start);
    const bytes = r.usage_unit === 'bytes';
    return {
      companyId: tenant.companyId, domain: r.domain, category: r.category, service: r.service, costKind: 'ESTIMATED', lineType: 'CHARGE',
      usageQuantity: bytes ? bytesToGb(r.usage_quantity.split('.')[0], params.gbBase) : r.usage_quantity, usageUnit: bytes ? 'GB' : r.usage_unit,
      amountCents: safeNumber(scaledToCents(BigInt(r.cost_scaled))), periodStart: start, periodEnd: new Date(start.getTime() + HOUR_MS),
      sourceRef: `${r.category.toLowerCase()}:${r.service}:${start.toISOString()}`, environment: r.environment,
    };
  });
  await ledger.recordLines(tenant, lines, transaction);
  await repo.markConsolidated(rows.map((r) => r.id), transaction);
  return lines.length;
}

module.exports = { recordUsage, consolidateClosedHours, hourStart, bytesToGb, SCALE };
