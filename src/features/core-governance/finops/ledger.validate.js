'use strict';

const { ENVIRONMENTS, CATEGORIES, COST_KINDS, LINE_TYPES } = require('./finops.constants');
const E = require('./finops.errors');

const asDate = (value) => (value instanceof Date ? value : new Date(value));

/**
 * Valida e normaliza uma linha do ledger (M9-D860 §3.1). Centavos inteiros (Number inteiro seguro ou BigInt); negativo SÓ em CREDIT de BILLED
 * (GOV_FINOPS_AMOUNT_INVALID); categoria, ambiente, tipo e linha fora das listas do livro são GOV_FINOPS_LINE_INVALID. O domínio é conferido pelo serviço.
 */
function normalizeLine(line, currency = 'BRL') {
  const bad = (message, details) => { throw E.lineInvalid(message, details); };
  if (!CATEGORIES.includes(line.category)) bad(`Categoria de custo inválida. Use: ${CATEGORIES.join(', ')}.`, { category: line.category });
  if (!ENVIRONMENTS.includes(line.environment)) bad(`Ambiente inválido. Use: ${ENVIRONMENTS.join(', ')}.`, { environment: line.environment });
  const costKind = line.costKind;
  if (!COST_KINDS.includes(costKind)) bad(`Tipo de custo inválido. Use: ${COST_KINDS.join(', ')}.`, { costKind });
  const lineType = line.lineType || 'CHARGE';
  if (!LINE_TYPES.includes(lineType)) bad(`Tipo de linha inválido. Use: ${LINE_TYPES.join(', ')}.`, { lineType });
  const service = typeof line.service === 'string' ? line.service.trim() : '';
  if (!service || service.length > 120) bad('O serviço do custo é obrigatório (até 120 caracteres).');
  const sourceRef = typeof line.sourceRef === 'string' ? line.sourceRef.trim() : '';
  if (!sourceRef || sourceRef.length > 200) bad('A referência da coleta (fatura ou coleta) é obrigatória (até 200 caracteres).');
  const domain = typeof line.domain === 'string' ? line.domain.trim().toUpperCase() : '';
  if (!domain || domain.length > 40) bad('O domínio do custo é obrigatório.');
  if ((line.currency || currency) !== currency) bad(`A moeda do ledger é ${currency}.`, { currency: line.currency });
  let cents;
  try { cents = typeof line.amountCents === 'bigint' ? line.amountCents : BigInt(line.amountCents); } catch (_) { return bad('O valor do custo deve ser um número inteiro de centavos.'); }
  if (typeof line.amountCents === 'number' && !Number.isInteger(line.amountCents)) bad('O valor do custo deve ser um número inteiro de centavos.');
  if (cents < 0n && !(lineType === 'CREDIT' && costKind === 'BILLED')) throw E.amountInvalid();
  const periodStart = asDate(line.periodStart);
  const periodEnd = asDate(line.periodEnd);
  if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime()) || periodEnd < periodStart) bad('O período do custo é inválido.');
  const usage = line.usageQuantity === undefined || line.usageQuantity === null ? '0' : String(line.usageQuantity);
  if (!/^\d{1,24}(\.\d{1,6})?$/.test(usage)) bad('A quantidade de uso deve ser um número não negativo.');
  return {
    companyId: line.companyId || null, environment: line.environment, domain, category: line.category, service, usageQuantity: usage,
    usageUnit: String(line.usageUnit || 'unit').slice(0, 20), amountCents: cents.toString(), currency, costKind, lineType, periodStart, periodEnd, sourceRef,
  };
}

module.exports = { normalizeLine };
