'use strict';

const { getSetting } = require('../../../settings/settings.service');
const { govError } = require('../../governance.errors');
const { IMPORT_BATCH_MAX_KEY, BCP_SETTING_DEFAULTS } = require('../bcp.settings');
const { userSectors } = require('../bcp.sectors');
const E = require('../bcp.errors');
const { UUID } = require('./refs');
const repository = require('./import.repository');
const { assertApprover } = require('../payment/payment.guard');
const { ACTION: PAYMENT_ACTION } = require('../payment/payment.constants');
const { importOperation } = require('./import.item');

const bad = (message, field) => govError(400, 'VALIDATION_ERROR', message, { field });

/** Lê o corpo do pedido: `ids` (lista de UUIDs) OU `correlationRef` (UUID do lote). */
function readSelection(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Envie o corpo da requisição em JSON.', 'body');
  const hasIds = body.ids !== undefined;
  const hasCorrelation = body.correlationRef !== undefined;
  if (hasIds === hasCorrelation) throw bad('Envie "ids" (lista de operações) ou "correlationRef" (lote), um dos dois.', 'ids');
  if (hasIds) {
    if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.some((x) => typeof x !== 'string' || !UUID.test(x))) throw bad('"ids" deve ser uma lista de ids de operação (UUID), com ao menos um.', 'ids');
    return { ids: [...new Set(body.ids.map((x) => x.toLowerCase()))] };
  }
  if (typeof body.correlationRef !== 'string' || !UUID.test(body.correlationRef)) throw bad('A referência de correlação deve ser um UUID.', 'correlationRef');
  return { correlationRef: body.correlationRef.toLowerCase() };
}

const count = (items, pick) => items.filter(pick).length;
const summarize = (items) => ({
  total: items.length, failed: count(items, (i) => i.error), alreadyImported: count(items, (i) => i.alreadyImported),
  reconciled: count(items, (i) => !i.error && !i.alreadyImported && i.status === 'RECONCILED'), divergent: count(items, (i) => !i.error && !i.alreadyImported && i.reconciliation && i.reconciliation.result === 'DIVERGENT'),
});

/**
 * POST /bcp/manual-operations/import (M9-D832 §3.1): importa a lista de operações (ou o lote de um correlation_ref), uma a uma, cada uma tudo ou nada. Operação de setor que
 * não é do usuário recusa o pedido inteiro (403 GOV_BCP_SECTOR_FORBIDDEN, nada é executado); o limite de operações por pedido é o parâmetro governanca.bcp.importacao_lote_max.
 */
async function importBatch({ tenant, actorUserId, body, transaction }) {
  const selection = readSelection(body);
  const max = Number(await getSetting(IMPORT_BATCH_MAX_KEY, tenant, transaction, BCP_SETTING_DEFAULTS[IMPORT_BATCH_MAX_KEY]));
  if (selection.ids && selection.ids.length > max) throw bad(`O pedido tem mais de ${max} operações (limite configurado).`, 'ids');
  const found = selection.ids ? await repository.operationsByIds(tenant.companyId, selection.ids, transaction) : await repository.operationsByCorrelation(tenant.companyId, selection.correlationRef, transaction);
  if (!found.length) throw govError(404, 'GOV_NOT_FOUND', 'Nenhuma operação manual encontrada para o pedido.');
  if (found.length > max) throw bad(`O lote tem mais de ${max} operações (limite configurado); importe por ids.`, 'correlationRef');
  const mine = await userSectors(actorUserId, tenant, transaction);
  if (found.some((op) => !mine.includes(op.sector))) throw E.sectorForbidden('importar operações');
  // Pagamento emergencial: quem importa é o checker_2 e precisa de governance:bcp:approve; sem ela o pedido inteiro é recusado antes de executar qualquer coisa (M9-D833).
  if (found.some((op) => op.intendedAction === PAYMENT_ACTION)) await assertApprover(tenant, actorUserId, transaction);
  const order = selection.ids ? [...found, ...selection.ids.filter((id) => !found.some((op) => op.id === id)).map((id) => ({ id }))] : found;
  const items = [];
  for (const op of order) items.push(await importOperation({ tenant, actorUserId, id: op.id, transaction }));
  return { items, summary: summarize(items) };
}

module.exports = { importBatch };
