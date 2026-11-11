'use strict';

/**
 * Guia M4 §10 "Importação bancária idempotente":
 *   fingerprint = sha256(bankAccountId + providerTransactionId + bookingAt + amount + direction + normalizedDescription)
 *   UNIQUE(bank_account_id, fingerprint)
 * Campos separados por "|"; bookingAt = dia de calendário em São Paulo (AAAA-MM-DD); amount em
 * valor absoluto com 2 casas; direction CREDIT (entrada, valor >= 0) ou DEBIT (saída, valor < 0);
 * descrição normalizada (minúsculas, espaços colapsados, sem espaço nas pontas). A migration
 * 20260101009985 calcula o mesmo valor em SQL para as linhas já gravadas.
 */
const crypto = require('node:crypto');
const { businessDateKey } = require('../../../../utils/businessDate');

function normalizeDescription(description) {
  return String(description || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function bankTransactionFingerprint({ bankAccountId, externalTransactionId, transactionDate, amount, description }) {
  const value = Number(amount);
  const parts = [
    String(bankAccountId || ''),
    String(externalTransactionId || ''),
    transactionDate && !Number.isNaN(new Date(transactionDate).getTime()) ? businessDateKey(new Date(transactionDate)) : '',
    Math.abs(value).toFixed(2),
    value < 0 ? 'DEBIT' : 'CREDIT',
    normalizeDescription(description),
  ];
  return crypto.createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

module.exports = { bankTransactionFingerprint, normalizeDescription };
