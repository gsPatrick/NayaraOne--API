'use strict';

/**
 * Idempotência das baixas (Caderno M4 §2 FIN-004: "Pagamento, recebimento, importação e baixa
 * crítica possuem chave idempotente"; Guia §16 "Recebimento parcial deixa saldo correto").
 *
 * - As rotas HTTP de baixa parcial, complemento e baixa integral EXIGEM a chave (`idempotencyKey` no corpo ou cabeçalho
 *   `Idempotency-Key`, 8 a 180 caracteres) — verificação 11/11/2026: a integral aceitava sem chave (M4-FIN-004).
 * - O movimento do ledger nunca fica sem chave: sem chave do cliente (chamada interna), a chave é a da intenção de
 *   pagamento ou uma interna (movementKeyForSettle / movementKeyForPartial).
 * - A coluna finance.financial_entries.idempotency_key é UNIQUE global (varchar 128). Para que
 *   duas empresas possam usar a mesma chave de cliente e para caber no tamanho, a chave gravada é
 *   derivada: `<tipo>:` + sha256(companyId + ':' + chave do cliente).
 * - Replay (mesma chave, mesmo lançamento, mesmo valor) devolve a baixa original com
 *   `idempotentReplay: true` sem criar nada. Mesma chave com outro lançamento/valor: 409
 *   IDEMPOTENCY_KEY_REUSED. A concorrência é serializada pelo FOR UPDATE do lançamento pai (a
 *   segunda requisição só lê depois que a primeira grava) e, por último, pelo UNIQUE do banco.
 */
const crypto = require('node:crypto');
const { FinancialEntry } = require('../../../../models');
const AppError = require('../../../../utils/AppError');

const MIN = 8;
const MAX = 180;

function readClientKey(req) {
  const fromBody = req.body && req.body.idempotencyKey;
  const fromHeader = req.header ? req.header('Idempotency-Key') : undefined;
  const raw = fromBody !== undefined && fromBody !== null && fromBody !== '' ? fromBody : fromHeader;
  if (raw === undefined || raw === null || raw === '') return null;
  return String(raw).trim();
}

function validateClientKey(key, { required }) {
  if (key === null || key === undefined || key === '') {
    if (!required) return null;
    throw AppError.badRequest(
      'Informe a chave de idempotência da baixa (idempotencyKey, de 8 a 180 caracteres). Ela impede que um duplo clique ou uma nova tentativa registre a baixa duas vezes.',
      'FINANCE_IDEMPOTENCY_KEY_REQUIRED'
    );
  }
  if (key.length < MIN || key.length > MAX) {
    throw AppError.badRequest(`A chave de idempotência precisa ter de ${MIN} a ${MAX} caracteres.`, 'FINANCE_IDEMPOTENCY_KEY_INVALID');
  }
  return key;
}

function deriveKey(kind, companyId, clientKey) {
  if (!clientKey) return null;
  return `${kind}:${crypto.createHash('sha256').update(`${companyId}:${clientKey}`).digest('hex')}`;
}

function toCents(value) {
  return Math.round(Number(value) * 100);
}

function reused(details) {
  return AppError.conflict(
    'Esta chave de idempotência já foi usada em outra baixa (outro lançamento ou outro valor). Gere uma chave nova para uma baixa nova.',
    'IDEMPOTENCY_KEY_REUSED',
    details
  );
}

/**
 * findPartialReplay — procura a baixa parcial já gravada com a chave derivada. Sem baixa: null.
 * Com baixa do mesmo lançamento e mesmo valor pedido (aplicado + excedente): o resultado do
 * replay. Qualquer outra combinação: 409 IDEMPOTENCY_KEY_REUSED.
 */
async function findPartialReplay(entry, derivedKey, partialAmount, transaction, computeRemainingAmount) {
  if (!derivedKey) return null;
  const settlement = await FinancialEntry.findOne({ where: { idempotencyKey: derivedKey }, transaction });
  if (!settlement) return null;
  const excess = await FinancialEntry.findOne({ where: { idempotencyKey: `${derivedKey}:excedente` }, transaction });
  const requestedCents = toCents(settlement.amount) + (excess ? toCents(excess.amount) : 0);
  if (settlement.parentEntryId !== entry.id || requestedCents !== toCents(partialAmount)) {
    throw reused({ existingSettlementId: settlement.id });
  }
  return {
    original: entry,
    settlement,
    remainingAmount: await computeRemainingAmount(entry, transaction),
    classificationPending: excess,
    idempotentReplay: true,
  };
}

/**
 * findSettleReplay — baixa integral. A 2ª chamada já é recusada por status (FOR UPDATE + só
 * PENDING liquida: 409 FINANCE_ENTRY_INVALID_STATUS). Quando a chave vem, ela é gravada na
 * auditoria da baixa (afterJson.settlementIdempotencyKey, derivada) e a repetição com a MESMA
 * chave devolve a baixa original (200, idempotentReplay) em vez do 409; a chave usada em outro
 * lançamento é 409 IDEMPOTENCY_KEY_REUSED.
 */
async function findSettleReplay(entry, derivedKey, transaction) {
  if (!derivedKey) return null;
  const { AuditLog, sequelize } = require('../../../../models');
  const row = await AuditLog.findOne({
    where: { action: 'finance.entry.settle', [require('sequelize').Op.and]: [sequelize.literal(`after_json->>'settlementIdempotencyKey' = ${sequelize.escape(derivedKey)}`)] },
    transaction,
  });
  if (!row) return null;
  if (row.entityId !== entry.id) throw reused({ existingEntryId: row.entityId });
  const plain = entry.toJSON();
  return { ...plain, idempotentReplay: true };
}

/**
 * Chave do MOVIMENTO da baixa integral (Caderno §7 idempotency_key NOT NULL; Guia §7 `idempotencyKey: locked.idempotencyKey`):
 * a chave do cliente (derivada, obrigatória na rota HTTP), a da intenção de pagamento confirmada pelo banco, ou a interna
 * desta baixa — um lançamento só é baixado por inteiro uma vez, então `baixa-integral:interna:<id>` é única.
 */
function movementKeyForSettle(entry, derivedKey, options = {}) {
  if (derivedKey) return derivedKey;
  const intent = options.paymentIntent;
  if (intent && intent.idempotencyKey) return intent.idempotencyKey;
  return `baixa-integral:interna:${entry.id}`;
}

/** Chave do movimento da baixa parcial sem chave do cliente (chamada interna): a compensação de caução é única por saída. */
function movementKeyForPartial(compensationOf) {
  return compensationOf ? `compensacao:${compensationOf}` : `baixa-parcial:interna:${crypto.randomUUID()}`;
}

module.exports = { readClientKey, validateClientKey, deriveKey, findPartialReplay, findSettleReplay, movementKeyForSettle, movementKeyForPartial, reused, MIN, MAX };
