'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../config/database');
const AppError = require('../../../utils/AppError');

/** Apoio comum aos provedores de impacto: consulta na transação do tenant (RLS vale), registro obrigatório, código curto e dinheiro em centavos. */
const rows = (transaction, sql, replacements = {}) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

async function one(transaction, sql, replacements, notFoundMessage, notFoundCode) {
  const [row] = await rows(transaction, sql, replacements);
  if (!row) throw AppError.notFound(notFoundMessage, notFoundCode);
  return row;
}

const count = async (transaction, sql, replacements) => Number((await rows(transaction, sql, replacements))[0].n);
/** Reais (NUMERIC) para centavos sem passar por ponto flutuante: o banco multiplica por 100. */
const centsSql = (expr) => `COALESCE(ROUND(SUM(${expr}) * 100), 0)::bigint`;
const toCents = (value) => Math.round(Number(value || 0) * 100);
const shortCode = (prefix, id) => `${prefix}-${String(id).replace(/-/g, '').slice(0, 8).toUpperCase()}`;
const blocker = (code, message) => ({ code, message });

module.exports = { rows, one, count, centsSql, toCents, shortCode, blocker };
