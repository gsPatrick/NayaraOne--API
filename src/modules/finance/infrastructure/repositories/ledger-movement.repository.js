'use strict';

/**
 * Repositório do movimento de ledger (Guia M4 §2). Os movimentos realizados são linhas de
 * finance.financial_entries (baixa parcial filha, complemento, excedente em pendência de classificação e estorno
 * compensatório) e a view finance.ledger mostra só o que foi realizado (Caderno §5/§7). Cada função recebe a
 * transação; as consultas são as mesmas que estavam nos serviços.
 */
const { Op } = require('sequelize');
const { FinancialEntry, sequelize } = require('../../../../models');
const { SETTLEMENT_CHILD_KINDS, MOVEMENT_KINDS } = require('../../domain/ledger-movement');

/** Grava um movimento novo (baixa parcial, excedente ou estorno). O ledger é append-only. */
function createMovement(values, transaction) {
  return FinancialEntry.create(values, { transaction });
}

// Baixa filha = filha que não é o excedente (§10). As linhas anteriores à coluna movement_kind foram classificadas pela
// migration 20260101010520; o filtro por natureza segura o excedente ainda não classificado.
const SETTLEMENT_CHILD = {
  [Op.or]: [{ movementKind: { [Op.in]: SETTLEMENT_CHILD_KINDS } }, { movementKind: null, nature: { [Op.ne]: 'PENDING_CLASSIFICATION' } }],
};

/** Baixas parciais filhas já liquidadas de um lançamento (base do saldo em aberto). */
function findSettledChildren(parentEntryId, transaction) {
  return FinancialEntry.findAll({ where: { parentEntryId, status: 'SETTLED', ...SETTLEMENT_CHILD }, transaction });
}

/** Baixas filhas realizadas, inclusive as já estornadas (o estorno aponta para elas). */
function findSettlementChildren(parentEntryId, transaction) {
  return FinancialEntry.findAll({ where: { parentEntryId, status: { [Op.in]: ['SETTLED', 'REVERSED'] }, ...SETTLEMENT_CHILD }, order: [['created_at', 'ASC'], ['id', 'ASC']], transaction });
}

function countSettledChildren(parentEntryId, transaction) {
  return FinancialEntry.count({ where: { parentEntryId, status: 'SETTLED', ...SETTLEMENT_CHILD }, transaction });
}

/** Lançamento que já tem baixa filha (em qualquer status): ele não é linha do ledger, as filhas é que são. */
async function hasSettlementChildren(parentEntryId, transaction) {
  return (await FinancialEntry.count({ where: { parentEntryId, ...SETTLEMENT_CHILD }, transaction })) > 0;
}

/** Centavos já estornados de cada movimento (estornos totais e parciais que apontam para ele). */
async function reversedCentsByMovement(movementIds, transaction) {
  const out = new Map();
  if (!movementIds.length) return out;
  const [rows] = await sequelize.query(
    `SELECT reversal_of_entry_id AS id, ROUND(SUM(amount) * 100)::bigint AS cents
       FROM finance.financial_entries
      WHERE reversal_of_entry_id IN (:ids) AND ledger_exclusion_reason IS NULL
      GROUP BY 1`,
    { replacements: { ids: movementIds }, transaction }
  );
  for (const r of rows) out.set(r.id, Number(r.cents));
  return out;
}

function countReversalsOf(movementId, transaction) {
  return FinancialEntry.count({ where: { reversalOfEntryId: movementId }, transaction });
}

/** Linhas da view finance.ledger com este id (movimento realizado). */
async function findLedgerRows(id, transaction) {
  const [rows] = await sequelize.query('SELECT id FROM finance.ledger WHERE id = :id', { replacements: { id }, transaction });
  return rows;
}

module.exports = {
  createMovement,
  findSettledChildren,
  findSettlementChildren,
  countSettledChildren,
  hasSettlementChildren,
  reversedCentsByMovement,
  countReversalsOf,
  findLedgerRows,
  MOVEMENT_KINDS,
};
