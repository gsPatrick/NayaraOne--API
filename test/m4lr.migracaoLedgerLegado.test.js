'use strict';

/**
 * Migration 20260101010520 (M4LR, Caderno M4 §7 DDL mínimo do ledger) — ida e volta com dado legado. Simula, como o dono das
 * tabelas (banco descartável), as linhas que o código antigo gravava: chave e autor nulos, baixa de 0,00 ("4e-3"), estorno de
 * previsto nunca realizado (sonda P2), estorno do valor cheio do pai com baixa parcial (P3) e pai SETTLED com baixa estornada
 * (P4). Confere a correção (nada apagado, contagem antes/depois e cada correção no log e no audit_log), o down (tudo volta) e a
 * nova ida. Rodar isolado, como os demais testes de migration (DATABASE_ADMIN_URL + DISPOSABLE_DB=1).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Sequelize } = require('sequelize');
const { sequelize } = require('./testHelpers');
const { isolatedTenant, closeIsolated } = require('./helpers/m4FinanceHttp');
const migration = require('../src/modules/finance/infrastructure/db/migrations/20260101010520-m4lr-ledger-ddl-minimo');
const { SYSTEM_ACTOR_ID } = require('../src/modules/finance/infrastructure/db/ledger-ddl-m4lr.sql');

let admin;
let tenant;

before(async () => {
  if (!process.env.DATABASE_ADMIN_URL || process.env.DISPOSABLE_DB !== '1') throw new Error('Rode em banco descartável (scripts/withDisposableDb.js).');
  admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false });
  tenant = await isolatedTenant('m4lr-migracao');
});

after(async () => {
  await admin.close();
  await closeIsolated();
  await sequelize.close();
});

const q = (sql, replacements) => admin.query(sql, { replacements, type: Sequelize.QueryTypes.SELECT });

/** Linha como o código antigo gravava (sem chave nem autor quando não informados). */
async function legacy(row) {
  const id = row.id || randomUUID();
  await admin.query(
    `INSERT INTO finance.financial_entries (id, group_id, company_id, entry_type, nature, amount, status, settled_at, parent_entry_id, reversal_of_entry_id,
                                            idempotency_key, created_by, description, competence_month, created_at, updated_at)
     VALUES (:id, :g, :c, :type, :nature, :amount, :status, :settledAt, :parent, :rev, :key, :by, :d, '2026-11', now(), now())`,
    { replacements: { id, g: tenant.groupId, c: tenant.companyId, type: row.type || 'CREDIT', nature: row.nature || 'RECEIVABLE', amount: row.amount, status: row.status,
      settledAt: row.settledAt || null, parent: row.parent || null, rev: row.rev || null, key: row.key || null, by: row.by || null, d: row.d || 'legado M4LR' } }
  );
  return id;
}

const at = '2026-11-05T12:00:00Z';
const net = async (ids) => {
  const [r] = await q(`SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS v, count(*)::int AS n FROM finance.ledger
                         WHERE id IN (:ids) OR reverses_ledger_id IN (:ids) OR financial_entry_id IN (:ids)`, { ids });
  return r;
};
const entry = async (id) => (await q('SELECT * FROM finance.financial_entries WHERE id = :id', { id }))[0];

test('M4-§7 migration de legado: corrige antes das constraints, audita, não apaga nada e volta pelo down', async () => {
  await migration.down(admin.getQueryInterface());

  const autor = (await q('SELECT id FROM core.users ORDER BY created_at LIMIT 1'))[0].id;
  // A (P1): pai de 0,30 PARTIALLY_SETTLED por uma baixa de 0,00 gravada a partir de "4e-3"; sem chave nem autor.
  const a = await legacy({ amount: '0.30', status: 'PARTIALLY_SETTLED' });
  const aZero = await legacy({ amount: '0.00', status: 'SETTLED', settledAt: at, parent: a });
  // B (P2): previsto de 50,00 nunca realizado, "estornado" com REVERSAL SETTLED.
  const b = await legacy({ amount: '50.00', status: 'REVERSED', by: autor });
  const bRev = await legacy({ type: 'DEBIT', nature: 'ADJUSTMENT', amount: '50.00', status: 'SETTLED', settledAt: at, rev: b, by: autor });
  // C (P3): pai de 0,30 com 0,10 baixado, estornado pelo valor cheio.
  const c = await legacy({ amount: '0.30', status: 'REVERSED', by: autor });
  const cChild = await legacy({ amount: '0.10', status: 'SETTLED', settledAt: at, parent: c, by: autor });
  const cRev = await legacy({ type: 'DEBIT', nature: 'ADJUSTMENT', amount: '0.30', status: 'SETTLED', settledAt: at, rev: c, by: autor });
  // D (P4): pai SETTLED (0,10 + 0,20) com a baixa de 0,10 estornada.
  const d = await legacy({ amount: '0.30', status: 'SETTLED', settledAt: at, by: autor });
  const d1 = await legacy({ amount: '0.10', status: 'REVERSED', settledAt: at, parent: d, by: autor });
  await legacy({ amount: '0.20', status: 'SETTLED', settledAt: at, parent: d, by: autor });
  await legacy({ type: 'DEBIT', nature: 'ADJUSTMENT', amount: '0.10', status: 'SETTLED', settledAt: at, rev: d1, by: autor });
  // E: autor nulo com a criação registrada na auditoria; F: excedente em pendência de classificação.
  const e = await legacy({ amount: '7.00', status: 'PENDING' });
  await admin.query(`INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, entity_id, before_json, after_json, reason, occurred_at, created_at, updated_at)
                     VALUES (gen_random_uuid(), :g, :c, :u, 'finance.entry.create', 'FinancialEntry', :e, '{}', '{}', 'legado', now(), now(), now())`,
  { replacements: { g: tenant.groupId, c: tenant.companyId, u: autor, e } });
  const f = await legacy({ amount: '5.00', status: 'PENDING', nature: 'PENDING_CLASSIFICATION', parent: d, key: 'legado-k:excedente', by: autor });

  const [antes] = await q('SELECT count(*)::int AS n FROM finance.financial_entries WHERE company_id = :c', { c: tenant.companyId });
  assert.equal((await net([c])).v, '-0.20', 'o defeito da sonda P3 no legado');
  assert.equal((await net([b])).v, '-50.00', 'o defeito da sonda P2 no legado');

  await migration.up(admin.getQueryInterface());

  const [depois] = await q('SELECT count(*)::int AS n FROM finance.financial_entries WHERE company_id = :c', { c: tenant.companyId });
  assert.equal(depois.n, antes.n + 1, 'nada apagado: só o estorno correto da baixa do pai C foi acrescentado');
  assert.equal((await entry(a)).idempotency_key, `legado:${a}`);
  assert.equal((await entry(a)).created_by, SYSTEM_ACTOR_ID, 'sem autor registrado: ator de sistema');
  assert.equal((await entry(e)).created_by, autor, 'autor achado na auditoria da criação');
  assert.match((await entry(aZero)).ledger_exclusion_reason, /0,00/);
  assert.equal((await entry(a)).status, 'PENDING', 'a baixa de 0,00 não é realizado: o pai volta a PENDING');
  assert.match((await entry(bRev)).ledger_exclusion_reason, /nunca foi realizado/);
  assert.equal((await net([b])).n, 0, 'P2: o previsto não tem linha no ledger');
  assert.match((await entry(cRev)).ledger_exclusion_reason, /valor cheio/);
  assert.equal((await entry(cChild)).status, 'REVERSED');
  assert.deepEqual(await net([c]), { v: '0.00', n: 2 }, 'P3: baixa 0,10 e o estorno dela');
  const [corr] = await q('SELECT idempotency_key, competence_month FROM finance.financial_entries WHERE reversal_of_entry_id = :id', { id: cChild });
  assert.equal(corr.idempotency_key, `reversal:${cChild}:correcao-m4lr`);
  const [dNow] = await q('SELECT status, settled_at FROM finance.financial_entries WHERE id = :id', { id: d });
  assert.deepEqual(dNow, { status: 'PARTIALLY_SETTLED', settled_at: null }, 'P4: status derivado do ledger');
  assert.equal((await entry(f)).movement_kind, 'EXCESS');
  const steps = (await q('SELECT step, count(*)::int AS n FROM finance.ledger_m4lr_migration_log WHERE company_id = :c GROUP BY step', { c: tenant.companyId }))
    .reduce((o, r) => ({ ...o, [r.step]: r.n }), {});
  for (const step of ['CONTAGEM_ANTES', 'CONTAGEM_DEPOIS', 'TIPO_DO_MOVIMENTO', 'CHAVE_LEGADO', 'AUTOR', 'VALOR_ZERO', 'ESTORNO_DE_NAO_REALIZADO', 'ESTORNO_DO_PAI_SUBSTITUIDO', 'ESTORNO_CORRECAO', 'BAIXA_ESTORNADA_NA_CORRECAO', 'STATUS_DERIVADO']) {
    assert.ok(steps[step] >= 1, `log da migration: ${step}`);
  }
  const [aud] = await q("SELECT before_json, after_json FROM audit.audit_log WHERE action = 'finance.ledger.m4lr_migration' AND company_id = :c", { c: tenant.companyId });
  assert.equal(aud.before_json.sem_chave > 0, true);
  assert.equal(aud.after_json.sem_chave, 0);
  assert.equal(aud.after_json.valor_nao_positivo, 1, 'a linha de 0,00 continua na tabela (fora do ledger)');
  const [rowAudit] = await q("SELECT count(*)::int AS n FROM audit.audit_log WHERE entity_type = 'FinancialEntryRow' AND entity_id = :id", { id: d });
  assert.ok(rowAudit.n >= 1, 'a mudança de status do pai ficou no audit_log (gatilho de colunas)');

  await migration.down(admin.getQueryInterface());
  const [volta] = await q('SELECT count(*)::int AS n FROM finance.financial_entries WHERE company_id = :c', { c: tenant.companyId });
  assert.equal(volta.n, antes.n, 'o down retira só o estorno de correção');
  assert.equal((await entry(a)).idempotency_key, null);
  assert.equal((await entry(a)).created_by, null);
  assert.equal((await entry(cChild)).status, 'SETTLED');
  assert.equal((await entry(d)).status, 'SETTLED');
  assert.ok((await entry(d)).settled_at);
  assert.equal((await net([c])).v, '-0.20');

  await migration.up(admin.getQueryInterface());
  assert.deepEqual(await net([c]), { v: '0.00', n: 2 }, 'a nova ida refaz a correção');
});
