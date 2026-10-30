'use strict';

const { startOfDay, endOfDayExclusive } = require('../days');
const ledger = require('../ledger.service');
const E = require('../finops.errors');
const { parseInvoice } = require('./billing.parse');

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Data só com dia = início do dia em Brasília (início) ou a meia-noite seguinte (fim, exclusivo); com hora, o instante informado. */
function boundary(value, isEnd) {
  const text = String(value || '').trim();
  if (DATE_ONLY.test(text)) return isEnd ? endOfDayExclusive(text) : startOfDay(text);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw E.invoiceInvalid(`Período da fatura inválido: ${text || '(vazio)'}.`);
  return date;
}

/**
 * Importa a fatura da nuvem ou do provider (CSV/JSON) como linhas BILLED de período fechado (M9-D860 §3.2). Período ainda aberto é recusado
 * (GOV_FINOPS_PERIOD_OPEN); fatura inválida não grava nada; a mesma fatura duas vezes não duplica (chave `fatura#linha`). Crédito = line_type CREDIT com valor negativo.
 * Cada linha BILLED substitui o ESTIMATED contido no seu período. Devolve { invoiceId, inserted, replayed, superseded }.
 */
async function importInvoice(tenant, { format, content, now = new Date(), category = 'CLOUD_SERVICE' }, transaction) {
  const invoice = parseInvoice(format, content);
  const lines = invoice.lines.map((l) => {
    const periodStart = boundary(l.periodStart, false);
    const periodEnd = boundary(l.periodEnd, true);
    if (periodEnd > now) throw E.periodOpen();
    return {
      companyId: tenant.companyId, category: l.category || category, service: l.service, domain: l.domain || 'PLATFORM', costKind: 'BILLED', lineType: l.lineType || 'CHARGE',
      amountCents: l.amountCents, usageQuantity: l.usageQuantity, usageUnit: l.usageUnit, periodStart, periodEnd, sourceRef: `${invoice.invoiceId}#${l.index}`,
    };
  });
  const out = await ledger.recordLines(tenant, lines, transaction);
  return { invoiceId: invoice.invoiceId, inserted: out.inserted, replayed: out.replayed, superseded: out.superseded };
}

/** Coletor de fatura do job: `source()` devolve [{format, content}] (arquivo da nuvem ou API do provider); sem fonte configurada não há o que importar. */
async function collectBilling(tenant, now, transaction, { source } = {}) {
  if (typeof source !== 'function') return 0;
  let count = 0;
  for (const invoice of await source(tenant)) {
    const out = await importInvoice(tenant, { ...invoice, now }, transaction);
    count += out.inserted + out.replayed;
  }
  return count;
}

module.exports = { importInvoice, collectBilling, boundary };
