'use strict';

const E = require('../finops.errors');
const { toScaled, scaledToCents, safeNumber } = require('../money');

/** CSV com aspas (RFC 4180 simples) -> linhas de células. */
function parseCsv(text) {
  const rows = [];
  let row = []; let cell = ''; let quoted = false;
  const src = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

const ALIASES = { period_start: 'periodStart', period_end: 'periodEnd', amount_cents: 'amountCents', amount_brl: 'amountBrl', usage_quantity: 'usageQuantity', usage_unit: 'usageUnit', line_type: 'lineType', invoice_id: 'invoiceId', cost_kind: 'costKind' };

/** Valor em reais ("4.120,00", "4120.00", "-15,5") -> centavos inteiros (half-even), sem float. */
function brlToCents(text) {
  const raw = String(text).trim();
  const negative = raw.startsWith('-');
  const normalized = raw.replace(/^-/, '').replace(/\s|R\$/g, '');
  const dotted = /,\d{1,2}$/.test(normalized) ? normalized.replace(/\./g, '').replace(',', '.') : normalized.replace(/,/g, '');
  const scaled = toScaled(dotted);
  if (scaled === null) return null;
  const cents = safeNumber(scaledToCents(scaled * 100n));
  return negative ? -cents : cents;
}

/**
 * Lê a fatura da nuvem em CSV (cabeçalho: invoice_id, period_start, period_end, category, service, domain, amount_cents ou amount_brl, usage_quantity, usage_unit, line_type)
 * ou JSON ({invoiceId, periodStart, periodEnd, lines:[...]}). Devolve { invoiceId, lines:[{...}] } ou lança GOV_FINOPS_INVOICE_INVALID (nada é gravado).
 */
function parseInvoice(format, content) {
  const fmt = String(format || '').toLowerCase();
  let header = {};
  let items;
  if (fmt === 'json') {
    let doc;
    try { doc = typeof content === 'string' ? JSON.parse(content) : content; } catch (_) { throw E.invoiceInvalid('A fatura em JSON não pôde ser lida.'); }
    if (!doc || !Array.isArray(doc.lines) || !doc.lines.length) throw E.invoiceInvalid('A fatura em JSON precisa de uma lista "lines" com ao menos uma linha.');
    header = { invoiceId: doc.invoiceId, periodStart: doc.periodStart, periodEnd: doc.periodEnd };
    items = doc.lines;
  } else if (fmt === 'csv') {
    const table = parseCsv(content);
    if (table.length < 2) throw E.invoiceInvalid('A fatura em CSV precisa de cabeçalho e ao menos uma linha.');
    const names = table[0].map((h) => { const k = h.trim().toLowerCase(); return ALIASES[k] || k; });
    items = table.slice(1).map((cells) => Object.fromEntries(names.map((n, i) => [n, (cells[i] ?? '').trim()])));
  } else throw E.invoiceInvalid('Formato de fatura não suportado. Use csv ou json.');
  const lines = items.map((item, index) => {
    const merged = { ...header, ...item };
    let cents = merged.amountCents;
    if ((cents === undefined || cents === '') && merged.amountBrl !== undefined) cents = brlToCents(merged.amountBrl);
    if (cents === null || cents === undefined || cents === '' || !/^-?\d+$/.test(String(cents))) throw E.invoiceInvalid(`Linha ${index + 1} da fatura sem valor válido.`, { line: index + 1 });
    const invoiceId = String(merged.invoiceId || '').trim();
    if (!invoiceId) throw E.invoiceInvalid(`Linha ${index + 1} da fatura sem identificador da fatura.`, { line: index + 1 });
    return {
      invoiceId, category: String(merged.category || '').toUpperCase(), service: merged.service, domain: merged.domain ? String(merged.domain).toUpperCase() : undefined,
      amountCents: Number(cents), usageQuantity: merged.usageQuantity === undefined || merged.usageQuantity === '' ? 0 : merged.usageQuantity, usageUnit: merged.usageUnit || 'unit',
      lineType: merged.lineType ? String(merged.lineType).toUpperCase() : undefined, periodStart: merged.periodStart, periodEnd: merged.periodEnd, index: index + 1,
    };
  });
  return { invoiceId: lines[0].invoiceId, lines };
}

module.exports = { parseInvoice, parseCsv, brlToCents };
