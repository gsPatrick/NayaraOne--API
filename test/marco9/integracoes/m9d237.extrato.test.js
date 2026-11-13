'use strict';

// Marco 9, M9-D237 — extrato por cursor idempotente (UNIQUE connection_id + entry_id) e conciliação por id externo e por (valor, favorecido, data). Roda com COMMIT.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d237Env');
const { SandboxBankAdapter } = require('../../../src/modules/finance/infrastructure/bank/providers/sandbox.provider');
const bank = require('../../../src/modules/finance/application/services/bank-hub');
const { Group, Company } = require('../../../src/models');

const { sequelize, withTenantTransaction, uniqueSuffix } = env;
let tenant;
let grupo;
let empresa;
before(async () => {
  tenant = await env.carregar();
  [grupo, empresa] = await withTenantTransaction(tenant, async (t) => [await Group.findByPk(tenant.groupId, { transaction: t }), await Company.findByPk(tenant.companyId, { transaction: t })]);
  await withTenantTransaction(tenant, (t) => bank.ensureBankConnection(env.ctxDe(), 'sandbox', t)); // o banco da empresa (sandbox) precisa estar ativo para o extrato ser lido
});
after(async () => { await sequelize.close(); });

const hoje = () => new Date().toISOString().slice(0, 10);
/** Extrato do banco em páginas de `porPagina` linhas, servido pelo cursor (o cursor é o índice da próxima linha). */
function extratoSimulado(linhas, porPagina = 2) {
  const marca = `${uniqueSuffix()}:`; // o cursor de outra simulação (guardado no banco) não vale: recomeça do início
  const original = SandboxBankAdapter.prototype.fetchTransactions;
  const pedidos = [];
  SandboxBankAdapter.prototype.fetchTransactions = async function fetchTransactions(cursor) {
    pedidos.push(cursor || null);
    const inicio = cursor && String(cursor).startsWith(marca) ? Number(String(cursor).slice(marca.length)) : 0;
    const fim = Math.min(inicio + porPagina, linhas.length);
    return { transactions: linhas.slice(inicio, fim), nextCursor: fim < linhas.length ? `${marca}${fim}` : null };
  };
  return { pedidos, restaurar: () => { SandboxBankAdapter.prototype.fetchTransactions = original; } };
}
const entrada = (over = {}) => ({ entryId: `ext-${uniqueSuffix()}`, direction: 'OUT', amount: '10.00', payeeName: 'Favorecido', bookedAt: hoje(), description: 'Saída', ...over });
const entradasDe = (ids) => withTenantTransaction(tenant, async (t) => env.linhas(t, 'SELECT * FROM finance.bank_statement_entries WHERE company_id = :c AND entry_id = ANY(ARRAY[:ids]::text[]) ORDER BY entry_id', { c: tenant.companyId, ids }));

async function enviarCommitado(opts) {
  let intent; let dono;
  await withTenantTransaction(tenant, async (t) => { const r = await env.intencaoEnviada(t, opts); intent = r.intent; dono = r.dono; });
  return { intent, dono };
}

test('banco_extrato_idempotente', async () => {
  const linhas = [entrada(), entrada(), entrada({ direction: 'IN', amount: '99.90' })];
  const sim = extratoSimulado(linhas);
  try {
    const um = await bank.sweepStatements({ group: grupo, company: empresa });
    assert.ok(um.imported >= 3, `importou as 3 linhas (${um.imported})`);
    assert.ok(sim.pedidos.length >= 2, 'o extrato é lido por páginas, pelo cursor');
    assert.equal((await entradasDe(linhas.map((l) => l.entryId))).length, 3);
    const dois = await bank.sweepStatements({ group: grupo, company: empresa });
    assert.equal(dois.imported, 0, 'reimportar o mesmo extrato não grava linha nova');
    assert.equal((await entradasDe(linhas.map((l) => l.entryId))).length, 3);
    // a regra mora no banco: o mesmo (connection_id, entry_id) é recusado
    const [existente] = await entradasDe([linhas[0].entryId]);
    await assert.rejects(withTenantTransaction(tenant, (t) => sequelize.query(
      'INSERT INTO finance.bank_statement_entries (group_id, company_id, connection_id, entry_id, direction, amount, booked_at) VALUES (:g, :c, :conn, :e, \'OUT\', 1.00, now())',
      { replacements: { g: tenant.groupId, c: tenant.companyId, conn: existente.connection_id, e: existente.entry_id }, transaction: t },
    )), /duplicate key|unique/i);
  } finally { sim.restaurar(); }
});

test('banco_conciliacao_por_external_id_e_valor', async () => {
  const a = await enviarCommitado({ amount: 321.45 });
  const b = await enviarCommitado({ amount: 77.7, payeeName: `Favorecido B ${uniqueSuffix()}` });
  const c = await enviarCommitado({ amount: 500 });
  const [da, db, dc] = await withTenantTransaction(tenant, (t) => Promise.all([a, b, c].map(async (x) => (await env.envios(t, x.intent.id))[0])));
  // b perde a resposta: UNKNOWN e sem id externo conhecido -> só o (valor, favorecido, data) o encontra
  await withTenantTransaction(tenant, (t) => sequelize.query("UPDATE integration.dispatches SET status = 'UNKNOWN', unknown_since = now() WHERE id = :id", { replacements: { id: db.id }, transaction: t }));
  const linhas = [
    entrada({ entryId: `por-id-${uniqueSuffix()}`, amount: '321.45', externalPaymentId: a.intent.externalSubmissionId, payeeName: 'Outro nome' }),
    entrada({ entryId: `por-valor-${uniqueSuffix()}`, amount: '77.70', payeeName: b.dono.legalName }),
    entrada({ entryId: `diverge-${uniqueSuffix()}`, amount: '5.00', externalPaymentId: c.intent.externalSubmissionId }),
  ];
  const sim = extratoSimulado(linhas, 10);
  try {
    await bank.sweepStatements({ group: grupo, company: empresa });
    const r = await bank.reconcileStatements({ group: grupo, company: empresa });
    assert.ok(r.reconciled >= 2 && r.mismatched >= 1, JSON.stringify(r));
    const [ea, eb, ec] = await entradasDe(linhas.map((l) => l.entryId).sort());
    const porId = (id) => [ea, eb, ec].find((e) => e.entry_id.startsWith(id));
    assert.equal(porId('por-id').reconciliation_status, 'RECONCILED');
    assert.equal(porId('por-valor').reconciliation_status, 'RECONCILED');
    assert.equal(porId('diverge').reconciliation_status, 'MISMATCH');
    const intents = await withTenantTransaction(tenant, (t) => env.linhas(t, 'SELECT id, status, reconciled_at, reconciled_entry_id FROM finance.payment_intents WHERE id = ANY(ARRAY[:ids]::uuid[])', { ids: [a.intent.id, b.intent.id, c.intent.id] }));
    const doIntent = (x) => intents.find((i) => i.id === x.intent.id);
    assert.ok(doIntent(a).reconciled_at && doIntent(b).reconciled_at, 'pagamento conciliado no Financeiro');
    assert.equal(doIntent(c).reconciled_at, null, 'valor diferente não concilia');
    // conciliar NÃO confirma: o envio segue onde estava
    const depois = await withTenantTransaction(tenant, (t) => Promise.all([da, db, dc].map(async (d) => (await env.linhas(t, 'SELECT status FROM integration.dispatches WHERE id = :id', { id: d.id }))[0].status)));
    assert.deepEqual(depois, ['SUBMITTED', 'UNKNOWN', 'SUBMITTED']);
    const erros = await withTenantTransaction(tenant, (t) => env.erros(t, 'INTEGRATION_BANK_AMOUNT_MISMATCH'));
    assert.ok(erros.some((e) => e.severity === 'CRITICAL' && e.status === 'OPEN'));
    // reconciliar de novo não repete nada
    const outra = await bank.reconcileStatements({ group: grupo, company: empresa });
    assert.equal(outra.reconciled, 0);
  } finally { sim.restaurar(); }
});
