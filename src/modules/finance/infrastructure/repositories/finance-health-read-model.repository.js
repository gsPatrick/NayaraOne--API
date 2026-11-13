'use strict';

/**
 * Leituras de CADASTRO da assistente financeira do Caderno §18 (contas bancárias em uso, nomes dos setores). Os números do read model do BI
 * (saúde financeira e margem por setor) são lidos pela camada de leitura do BI, com a permissão do domínio Financeiro
 * (src/features/analytics/read-models/finance-assistant.read.js, M9-D700) — nunca aqui.
 */
const { sequelize } = require('../../../../models');

const select = async (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: sequelize.QueryTypes.SELECT });

/** Cadastro: quantas contas bancárias próprias em uso a empresa tem. */
async function countActiveBankAccounts(transaction) {
  const [row] = await select("SELECT COUNT(*)::int AS total FROM finance.bank_accounts WHERE deleted_at IS NULL AND status <> 'BLOCKED'", {}, transaction);
  return row ? row.total : 0;
}

/** Cadastro: nome de cada setor (centro de resultado). */
async function findResultCenterNames(ids, transaction) {
  if (!ids.length) return new Map();
  const rows = await select('SELECT id::text AS id, name FROM finance.result_centers WHERE id IN (:ids)', { ids }, transaction);
  return new Map(rows.map((r) => [r.id, r.name]));
}

module.exports = { countActiveBankAccounts, findResultCenterNames };
