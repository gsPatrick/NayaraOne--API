'use strict';

/**
 * Saldos calculados a partir do ledger (Guia M4 §2 "cálculo de saldo em decimal exato"; Caderno §10 e §13):
 * saldo em aberto de um lançamento e saldo de uma caução (dinheiro de terceiro). Nada é armazenado: o saldo
 * vem sempre das linhas do ledger, somadas em centavos inteiros (domain/ledger-movement.js).
 */
const AppError = require('../../../../utils/AppError');
const entries = require('../../infrastructure/repositories/financial-entry.repository');
const ledger = require('../../infrastructure/repositories/ledger-movement.repository');
const { remainingAmount, receivedCentsOf, thirdPartyBalance } = require('../../domain/ledger-movement');

async function getEntryOrFail(id, transaction) {
  const entry = await entries.findById(id, transaction);
  if (!entry) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  return entry;
}

/**
 * computeRemainingAmount — saldo em aberto do lançamento = amount - Σ(baixas parciais filhas
 * que estão SETTLED). Retorna string com 2 casas (mesma precisão do DECIMAL(18,2)).
 */
async function computeRemainingAmount(entryOrId, transaction) {
  const entry = typeof entryOrId === 'string' ? await getEntryOrFail(entryOrId, transaction) : entryOrId;
  const children = await ledger.findSettledChildren(entry.id, transaction);
  return remainingAmount(entry.amount, children);
}

// F04 (conferência Nayara 18/10/2026) — rastreabilidade de caução / dinheiro de terceiros.
// Caderno Financeiro §13: "Movimentação exige vínculo com contrato e titular.
// Devolução/compensação cria evento e ledger próprio." Toda SAÍDA de dinheiro de terceiro
// (PAYABLE com isThirdPartyFunds) aponta para o recebimento de origem e é validada contra ele:
// mesmo contrato, mesmo titular e valor até o saldo ainda não devolvido/compensado daquela origem.
async function receivedAmountCents(origin, transaction) {
  const children = origin.status === 'PARTIALLY_SETTLED' ? await ledger.findSettledChildren(origin.id, transaction) : [];
  return receivedCentsOf(origin, children);
}

async function computeThirdPartyOriginBalance(originOrId, transaction) {
  const origin = typeof originOrId === 'string' ? await entries.findById(originOrId, transaction) : originOrId;
  if (!origin) throw AppError.notFound('Recebimento de origem não encontrado.', 'FINANCE_THIRD_PARTY_ORIGIN_NOT_FOUND');
  const received = await receivedAmountCents(origin, transaction);
  const releases = await entries.findActiveReleases(origin.id, transaction);
  return thirdPartyBalance(origin, received, releases);
}

module.exports = { computeRemainingAmount, computeThirdPartyOriginBalance };
