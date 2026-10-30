'use strict';

const { sequelize } = require('../../../models');
const { toDecimal, toCents } = require('./bank.money');

/**
 * Lançamento do extrato na forma interna (M9-D237 3.3 item 4). O banco manda o que tem; aqui só se lê o que identifica o lançamento: o id do banco (`entryId`, a chave de
 * idempotência), o sentido, o valor (sempre positivo, texto decimal), a data, o favorecido e o id externo do pagamento quando o banco o informa. Lançamento sem id ou com valor
 * ilegível é recusado (devolve null): nunca se inventa um lançamento.
 */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const entryId = raw.entryId ?? raw.id ?? raw.transactionId ?? raw.externalTransactionId;
  const bruto = raw.amount ?? raw.value;
  const cents = toCents(bruto);
  if (!entryId || cents === null) return null;
  const quando = new Date(raw.bookedAt ?? raw.date ?? raw.transactionDate ?? Date.now());
  if (Number.isNaN(quando.getTime())) return null;
  const direction = String(raw.direction || (cents < 0 ? 'OUT' : 'IN')).toUpperCase() === 'OUT' ? 'OUT' : 'IN';
  const nome = raw.payeeName ?? raw.counterpartName ?? raw.beneficiaryName ?? null;
  const externo = raw.externalPaymentId ?? raw.paymentId ?? null;
  return {
    entryId: String(entryId).slice(0, 128), direction, amount: toDecimal(Math.abs(cents) / 100), bookedAt: quando,
    description: raw.description ? String(raw.description).slice(0, 500) : null, payeeName: nome ? String(nome).slice(0, 200) : null, externalPaymentId: externo ? String(externo).slice(0, 160) : null,
  };
}

const INSERT_SQL = `
INSERT INTO "finance"."bank_statement_entries" (group_id, company_id, connection_id, entry_id, direction, amount, booked_at, description, payee_name, external_payment_id)
VALUES (:groupId, :companyId, :connectionId, :entryId, :direction, :amount, :bookedAt, :description, :payeeName, :externalPaymentId)
ON CONFLICT (connection_id, entry_id) DO NOTHING
RETURNING id`;

/** Grava os lançamentos; o par (connection_id, entry_id) UNIQUE faz a reimportação não duplicar. Devolve a quantidade NOVA. */
async function insertEntries(ctx, connectionId, entries, transaction) {
  let novos = 0;
  for (const e of entries) {
    // eslint-disable-next-line no-await-in-loop
    const [rows] = await sequelize.query(INSERT_SQL, { replacements: { groupId: ctx.groupId, companyId: ctx.companyId, connectionId, ...e }, transaction });
    novos += rows.length;
  }
  return novos;
}

module.exports = { normalizeEntry, insertEntries };
