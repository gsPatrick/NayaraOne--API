'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { TIME_ZONE } = require('../bcp.constants');

/** Acesso a governance.bcp_payment_pendings (M9-D833). A RLS isola pela empresa; o filtro por company_id vale de qualquer forma. */
const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
const COLUMNS = `p.id, p.group_id AS "groupId", p.company_id AS "companyId", p.manual_operation_id AS "manualOperationId", p.manual_reference AS "manualReference",
  p.amount_cents AS "amountCents", to_char(p.occurred_on, 'YYYY-MM-DD') AS "occurredOn", to_char(p.deadline_on, 'YYYY-MM-DD') AS "deadlineOn", p.imported_by AS "importedBy",
  p.status, p.bank_transaction_id AS "bankTransactionId", p.last_alert_key AS "lastAlertKey"`;

async function insertPending(row, transaction) {
  const rows = await select(
    `INSERT INTO governance.bcp_payment_pendings AS p (group_id, company_id, manual_operation_id, manual_reference, amount_cents, occurred_on, deadline_on, imported_by)
     VALUES (:groupId, :companyId, :manualOperationId, :manualReference, :amountCents, :occurredOn, :deadlineOn, :importedBy)
     ON CONFLICT (manual_operation_id) DO NOTHING RETURNING ${COLUMNS}`, row, transaction
  );
  return rows[0] || null;
}

/** Pendências abertas da empresa, travadas para a passada (duas passadas simultâneas não alertam nem casam a mesma). */
const lockOpen = (companyId, transaction) => select(
  `SELECT ${COLUMNS} FROM governance.bcp_payment_pendings p WHERE p.company_id = :companyId AND p.status = 'OPEN' ORDER BY p.deadline_on, p.manual_reference FOR UPDATE SKIP LOCKED`,
  { companyId }, transaction
);

/** Linha de saída do extrato com valor IGUAL em centavos, dia (Brasília) entre `from` e `to`, ainda não casada com outra pendência. Tolerância zero. */
async function findLine({ companyId, amountCents, from, to }, transaction) {
  const rows = await select(
    `SELECT bt.id FROM finance.bank_transactions bt
      WHERE bt.company_id = :companyId AND bt.amount < 0 AND ROUND(-bt.amount * 100) = :amountCents
        AND (bt.transaction_date AT TIME ZONE :zone)::date BETWEEN CAST(:from AS date) AND CAST(:to AS date)
        AND NOT EXISTS (SELECT 1 FROM governance.bcp_payment_pendings x WHERE x.bank_transaction_id = bt.id)
      ORDER BY bt.transaction_date, bt.created_at, bt.id LIMIT 1 FOR UPDATE OF bt SKIP LOCKED`,
    { companyId, amountCents, from, to, zone: TIME_ZONE }, transaction
  );
  return rows[0] ? rows[0].id : null;
}

async function markMatched(companyId, id, bankTransactionId, transaction) {
  const rows = await select(
    "UPDATE governance.bcp_payment_pendings SET status = 'MATCHED', bank_transaction_id = :bankTransactionId, matched_at = now(), updated_at = now() WHERE company_id = :companyId AND id = :id AND status = 'OPEN' RETURNING id",
    { companyId, id, bankTransactionId }, transaction
  );
  return rows.length > 0;
}

const markAlerted = (companyId, id, key, transaction) => select(
  'UPDATE governance.bcp_payment_pendings SET last_alert_key = :key, last_alerted_at = now(), updated_at = now() WHERE company_id = :companyId AND id = :id RETURNING id',
  { companyId, id, key }, transaction
);

const cancelByOperation = (companyId, manualOperationId, transaction) => select(
  "UPDATE governance.bcp_payment_pendings SET status = 'CANCELED', updated_at = now() WHERE company_id = :companyId AND manual_operation_id = :manualOperationId AND status = 'OPEN' RETURNING id",
  { companyId, manualOperationId }, transaction
);

module.exports = { insertPending, lockOpen, findLine, markMatched, markAlerted, cancelByOperation };
