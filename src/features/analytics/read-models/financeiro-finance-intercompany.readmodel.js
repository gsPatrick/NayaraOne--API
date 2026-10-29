'use strict';

/**
 * M9-D625 — read model rm_finance_intercompany (schema analytics): uma linha por transferência aprovada entre empresas do grupo, da empresa de ORIGEM,
 * com o estado dos dois lados (ver intercompany.pairs.js). O consolidado do grupo lê estas linhas para eliminar o intercompany na leitura (BI-004);
 * o ledger nunca recebe linha consolidada. Estado, nunca delta: cada passada refaz as linhas da empresa a partir de finance.intercompany_transfers e
 * dos lançamentos dos dois lados. O lado do destino é lido sob o contexto da empresa de destino (RLS por empresa), como o próprio Financeiro faz na
 * aprovação, e o contexto da origem é restaurado em seguida. Quem publica a aprovação atualiza na hora; a baixa no destino chega pela agenda (15 min).
 */
const { sequelize } = require('../../../models');
const { registerReadModel } = require('./readModel.registry');
const { pairState, pairFields } = require('./intercompany.pairs');

const MODEL = 'rm_finance_intercompany';
const NIL = '00000000-0000-0000-0000-000000000000';
const EVENTS = Object.freeze(['finance.intercompany_transfer.approved', 'finance.entry.settled', 'finance.entry.reversed', 'finance.entry.canceled']);
const LEG_KEY = 'intercompany-transfer:%';
const rows = async (sql, replacements, transaction) => (await sequelize.query(sql, { replacements, transaction }))[0];

/** Troca a empresa do contexto de RLS da transação (leitura do lado do destino) e devolve o que `fn` ler; a empresa de origem é restaurada. */
async function inCompany(companyId, restoreCompanyId, transaction, fn) {
  const set = (id) => sequelize.query("SELECT set_config('app.company_id', :id, true)", { replacements: { id }, transaction });
  await set(companyId);
  try {
    return await fn();
  } finally {
    await set(restoreCompanyId);
  }
}

const ENTRY_COLUMNS = 'id, status, amount::text AS amount, due_at, settled_at';
const entryOf = async (id, transaction) => (id ? (await rows(`SELECT ${ENTRY_COLUMNS} FROM finance.financial_entries WHERE id = :id`, { id }, transaction))[0] || null : null);

async function aggregateKey(event, { transaction } = {}) {
  if (event.eventType === 'finance.intercompany_transfer.approved') return { transfer_id: NIL };
  const id = (event.payloadJson || event.payload || {}).id;
  if (!id || !transaction) return null;
  const hit = await rows('SELECT 1 FROM finance.financial_entries WHERE id = :id AND idempotency_key LIKE :key', { id, key: LEG_KEY }, transaction);
  return hit.length ? { transfer_id: NIL } : null;
}

async function recompute({ companyId, now, transaction }) {
  const transfers = await rows(
    `SELECT id, to_company_id, amount::text AS amount, status, from_entry_id, to_entry_id FROM finance.intercompany_transfers
      WHERE company_id = :companyId AND status IN ('PENDING', 'RECONCILED') ORDER BY created_at, id`, { companyId }, transaction);
  const out = [];
  for (const t of transfers) {
    const from = await entryOf(t.from_entry_id, transaction);
    const to = t.to_entry_id ? await inCompany(t.to_company_id, companyId, transaction, () => entryOf(t.to_entry_id, transaction)) : null;
    const state = pairState(t, from, to);
    if (state) out.push({ key: { transfer_id: t.id }, fields: pairFields(t, from, to, state) });
  }
  return { fields: {}, rows: out, sourceSnapshotAt: now };
}

/** A agenda reconfere as transferências da empresa (a baixa do lado do destino não gera evento para a origem). Só quem tem transferência ou linha gravada. */
async function scheduledKeys({ companyId, transaction }) {
  const any = await rows(
    `SELECT 1 FROM finance.intercompany_transfers WHERE company_id = :companyId AND status IN ('PENDING', 'RECONCILED')
      UNION ALL SELECT 1 FROM analytics.${MODEL} WHERE company_id = :companyId LIMIT 1`, { companyId }, transaction);
  return any.length ? [{ transfer_id: NIL }] : [];
}

const def = registerReadModel({
  name: MODEL, version: 1, keyColumns: ['transfer_id'], aggregateColumns: [], eventTypes: [...EVENTS], aggregateKey, recompute,
  scheduled: { keys: scheduledKeys }, rebuild: { keys: async ({ companyId, transaction }) => scheduledKeys({ companyId, transaction }) },
});

module.exports = { def, recompute, MODEL };
