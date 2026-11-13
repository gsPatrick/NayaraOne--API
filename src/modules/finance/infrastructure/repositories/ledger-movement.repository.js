'use strict';

/**
 * Repositório do movimento de ledger (Guia M4 §2). Os movimentos realizados são linhas de
 * finance.financial_entries (baixa parcial filha, excedente em pendência de classificação e estorno
 * compensatório) e a view finance.ledger mostra só o que foi realizado (Caderno §5/§7). Cada função recebe a
 * transação; as consultas são as mesmas que estavam nos serviços.
 */
const { FinancialEntry, sequelize } = require('../../../../models');

/** Grava um movimento novo (baixa parcial, excedente ou estorno). O ledger é append-only. */
function createMovement(values, transaction) {
  return FinancialEntry.create(values, { transaction });
}

/** Baixas parciais filhas já liquidadas de um lançamento (base do saldo em aberto). */
function findSettledChildren(parentEntryId, transaction) {
  return FinancialEntry.findAll({ where: { parentEntryId, status: 'SETTLED' }, transaction });
}

function countSettledChildren(parentEntryId, transaction) {
  return FinancialEntry.count({ where: { parentEntryId, status: 'SETTLED' }, transaction });
}

/** Linhas da view finance.ledger com este id (movimento realizado). */
async function findLedgerRows(id, transaction) {
  const [rows] = await sequelize.query('SELECT id FROM finance.ledger WHERE id = :id', { replacements: { id }, transaction });
  return rows;
}

module.exports = { createMovement, findSettledChildren, countSettledChildren, findLedgerRows };
