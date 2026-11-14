'use strict';

// Marco 4 — Guia §9 ">= regra AUTO_STRONG: auto conforme policy; faixa intermediária: sugestão; múltiplos candidatos fortes: AMBIGUOUS, nunca auto"
// (limiares e janela como parâmetros da empresa, DEC-006; antes eram constantes 0,90/0,45/5 dias/0,05 no código) e Caderno §11 "Exato: auto
// confirmado se FONTE CONFIÁVEL" / FIN-009 "confirmação conforme risco" (antes: linha digitada à mão com id externo igual era conciliada sozinha).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M4CC_RECON_HTTP_TEST_PORT || process.env.FINANCE_RECON_HTTP_TEST_PORT || '21597';

require('../app');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix, createTestCostCenter } = require('./testHelpers');
const { gravarParametro } = require('./helpers/mfaRecente');
const { tokenFor, client, isolatedTenant, closeIsolated } = require('./helpers/m4FinanceHttp');
const bankAccountsService = require('../src/modules/finance/application/services/bank-accounts.service');
const bankTransactionsService = require('../src/modules/finance/application/services/bank-transactions.service');
const financialEntriesService = require('../src/modules/finance/application/services/financial-entry.service');
const reconciliationService = require('../src/modules/finance/application/services/reconciliation.service');

let tenant;
let http;
before(async () => {
  tenant = await getSeedTenant();
  http = client(`http://127.0.0.1:${process.env.PORT}/api/v1`);
  await new Promise((resolve) => setTimeout(resolve, 300));
});
after(async () => {
  await closeIsolated();
  await sequelize.close();
  process.exit(0);
});

const DAY = 86400000;
const TRUSTED = { source: 'FILE_IMPORT', canReconcile: true };
const ctx = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });

async function account(t) {
  return bankAccountsService.createBankAccount({ ...ctx(), bankCode: '001', agency: '0001', accountNumber: `${uniqueSuffix()}` }, tenant.userId, t);
}
async function entry(t, overrides) {
  const cc = await createTestCostCenter(tenant, t);
  return financialEntriesService.createFinancialEntry(
    { ...ctx(), entryType: 'DEBIT', nature: 'PAYABLE', amount: 500, description: `AUTO_STRONG ${uniqueSuffix()}`, costCenterId: cc.id, ...overrides }, tenant.userId, t
  );
}
function bankTx(t, acc, overrides, origin) {
  return bankTransactionsService.createBankTransaction({ ...ctx(), bankAccountId: acc.id, transactionDate: new Date(), ...overrides }, tenant.userId, t, origin);
}
const auto = (t, id) => reconciliationService.autoReconcileSuggestion({ ...ctx(), bankTransactionId: id }, tenant.userId, t);

test('M4-G§9 padrões da regra AUTO_STRONG: forte 0,90 e janela de 3 dias (DEC-006), sugestão 0,45 e folga 0,05 (DI-M4CC-3), forte não confirma sozinha', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { readPolicy } = require('../src/modules/finance/application/services/reconciliation-policy');
    assert.deepEqual(await readPolicy(ctx(), t), { autoScoreMin: 0.9, suggestionScoreMin: 0.45, dateWindowDays: 3, ambiguityGap: 0.05, autoStrong: false });
  });
});

test('M4-§11.1/FIN-009 EXATO de linha digitada à mão NÃO concilia sozinho (fonte não confiável); o mesmo EXATO de arquivo de quem concilia, sim', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const acc = await account(t);
    const keyA = `m4cc-man-${uniqueSuffix()}`;
    await entry(t, { amount: 610.37, bankAccountId: acc.id, idempotencyKey: keyA });
    const manual = await bankTx(t, acc, { amount: -610.37, externalTransactionId: keyA, source: 'WEBHOOK', sourceTrusted: true }); // corpo forjado é ignorado
    assert.equal(manual.source, 'MANUAL');
    assert.equal(manual.sourceTrusted, false);
    const r1 = await auto(t, manual.id);
    assert.equal(r1.finalClass, 'EXACT');
    assert.equal(r1.autoReconciled, false);
    assert.equal(r1.autoBlockedReason, 'UNTRUSTED_SOURCE');

    const keyB = `m4cc-imp-${uniqueSuffix()}`;
    await entry(t, { amount: 611.37, bankAccountId: acc.id, idempotencyKey: keyB });
    const semPermissao = await bankTx(t, acc, { amount: -611.37, externalTransactionId: keyB }, { source: 'FILE_IMPORT', canReconcile: false });
    assert.equal((await auto(t, semPermissao.id)).autoBlockedReason, 'UNTRUSTED_SOURCE', 'arquivo importado sem finance:reconcile não é fonte confiável');

    const keyC = `m4cc-ok-${uniqueSuffix()}`;
    const e = await entry(t, { amount: 612.37, bankAccountId: acc.id, idempotencyKey: keyC });
    const confiavel = await bankTx(t, acc, { amount: -612.37, externalTransactionId: keyC }, TRUSTED);
    const r3 = await auto(t, confiavel.id);
    assert.equal(r3.autoReconciled, true);
    assert.equal(r3.method, 'AUTO_EXACT');
    assert.equal(r3.reconciliation.financialEntryId, e.id);
  });
});

test('M4-G§9 FORTE só confirma sozinho com a política ligada, de fonte confiável e score >= score_auto_minimo; subir o mínimo faz a mesma linha virar PROVÁVEL', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const acc = await account(t);
    // valor + referência + conta = 0,90 (vencimento fora da janela)
    const e = await entry(t, { amount: 620.37, bankAccountId: acc.id, dueAt: new Date(Date.now() + 20 * DAY) });
    const tx = await bankTx(t, acc, { amount: -620.37, description: `ref ${e.id}` }, TRUSTED);
    assert.equal((await auto(t, tx.id)).autoBlockedReason, 'AUTO_STRONG_OFF');
    await gravarParametro('finance.reconciliation.auto_strong', true, ctx(), t);
    await gravarParametro('conciliacao.score_auto_minimo', 0.95, ctx(), t);
    const s = await reconciliationService.suggestReconciliationMatches(tx.id, t);
    assert.equal(s.candidates[0].score, 0.9);
    assert.equal(s.finalClass, 'PROBABLE', 'com o mínimo em 0,95 a pontuação 0,90 deixa de ser forte');
    assert.equal(s.policy.autoScoreMin, 0.95);
    assert.equal((await auto(t, tx.id)).autoReconciled, false);
    await gravarParametro('conciliacao.score_auto_minimo', 0.9, ctx(), t);
    const r = await auto(t, tx.id);
    assert.equal(r.finalClass, 'STRONG');
    assert.equal(r.autoReconciled, true);
    assert.equal(r.method, 'AUTO_STRONG');
    const e2 = await entry(t, { amount: 621.37, bankAccountId: acc.id });
    const manual = await bankTx(t, acc, { amount: -621.37, description: `ref ${e2.id}` });
    assert.equal((await auto(t, manual.id)).autoBlockedReason, 'UNTRUSTED_SOURCE', 'política ligada não abre exceção para linha digitada');
  });
});

test('M4-G§9 janela de data e mínimo de sugestão são parâmetros: mudam a pontuação e a classe', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const acc = await account(t);
    const due = new Date(Date.now() - 2 * DAY);
    await entry(t, { amount: 630.37, dueAt: due }); // sem conta: valor + data = 0,55
    const tx = await bankTx(t, acc, { amount: -630.37, description: 'PIX' });
    const a = await reconciliationService.suggestReconciliationMatches(tx.id, t);
    assert.equal(a.candidates[0].score, 0.55, 'vencimento há 2 dias, dentro da janela padrão de 3');
    assert.equal(a.finalClass, 'PROBABLE');
    await gravarParametro('conciliacao.janela_data_dias', 1, ctx(), t);
    const b = await reconciliationService.suggestReconciliationMatches(tx.id, t);
    assert.equal(b.candidates[0].score, 0.45, 'fora da janela de 1 dia o critério de data não pontua');
    await gravarParametro('conciliacao.score_sugestao_minimo', 0.5, ctx(), t);
    const c = await reconciliationService.suggestReconciliationMatches(tx.id, t);
    assert.equal(c.finalClass, 'NO_MATCH', 'abaixo do mínimo de sugestão vai para a fila de pendência');
  });
});

test('M4-G§9 folga de empate é parâmetro; dois candidatos fortes são AMBÍGUO qualquer que seja a folga, nunca auto', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const acc = await account(t);
    const forte = await entry(t, { amount: 640.37, bankAccountId: acc.id });
    await entry(t, { amount: 640.37, bankAccountId: acc.id, dueAt: new Date(Date.now() + 20 * DAY) }); // valor + conta = 0,60
    const tx = await bankTx(t, acc, { amount: -640.37, description: `ref ${forte.id}` }, TRUSTED); // topo: 1,00 (forte por referência textual)
    assert.equal((await reconciliationService.suggestReconciliationMatches(tx.id, t)).finalClass, 'STRONG');
    await gravarParametro('conciliacao.folga_ambiguidade', 0.5, ctx(), t);
    const amb = await reconciliationService.suggestReconciliationMatches(tx.id, t);
    assert.equal(amb.finalClass, 'AMBIGUOUS', 'segundo candidato a 0,40 do topo, com folga 0,50, empata');
    await gravarParametro('finance.reconciliation.auto_strong', true, ctx(), t);
    assert.equal((await auto(t, tx.id)).autoReconciled, false);

    await gravarParametro('conciliacao.folga_ambiguidade', 0, ctx(), t);
    const acc2 = await account(t);
    const k = `ref-${uniqueSuffix()}`;
    const e1 = await entry(t, { amount: 641.37, bankAccountId: acc2.id, description: k });
    await entry(t, { amount: 641.37, bankAccountId: acc2.id, description: k });
    const tx2 = await bankTx(t, acc2, { amount: -641.37, description: 'sem referência' }, TRUSTED);
    void e1;
    const dois = await reconciliationService.suggestReconciliationMatches(tx2.id, t);
    assert.equal(dois.candidates.length, 2);
    assert.equal(dois.finalClass, 'AMBIGUOUS', 'mesmo score com folga 0: empate exato é sempre ambíguo');
  });
});

test('M4-G§9 travas dos parâmetros: faixa do catálogo e mínimo automático acima do mínimo de sugestão', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await assert.rejects(gravarParametro('conciliacao.score_auto_minimo', 0.4, ctx(), t), (e) => e.code === 'SETTING_INVALID_VALUE');
    await assert.rejects(gravarParametro('conciliacao.janela_data_dias', 31, ctx(), t), (e) => e.code === 'SETTING_INVALID_VALUE');
    await assert.rejects(gravarParametro('conciliacao.score_sugestao_minimo', 0.95, ctx(), t), (e) => e.code === 'SETTING_INVALID_VALUE' && /mínima para confirmar/.test(e.message));
    await gravarParametro('conciliacao.score_sugestao_minimo', 0.8, ctx(), t);
    await assert.rejects(gravarParametro('conciliacao.score_auto_minimo', 0.75, ctx(), t), (e) => e.code === 'SETTING_INVALID_VALUE' && /mínima para sugerir/.test(e.message));
  });
});

test('M4-§11.1 via HTTP: linha criada por POST /finance/bank-transactions é MANUAL mesmo com origem forjada no corpo e não concilia sozinha; GET /finance/reconciliation/policy mostra a regra', async () => {
  const iso = await isolatedTenant('auto-strong');
  const token = tokenFor(iso, tenant.userId);
  const acc = await http('POST', '/finance/bank-accounts', token, { bankCode: '341', agency: '0001', accountNumber: `${uniqueSuffix()}` });
  assert.equal(acc.status, 201, JSON.stringify(acc.body));
  const key = `m4cc-http-${uniqueSuffix()}`;
  const cc = await http('POST', '/finance/cost-centers', token, { name: `CC ${uniqueSuffix()}`, code: `C${uniqueSuffix().slice(-8)}` });
  assert.equal(cc.status, 201, JSON.stringify(cc.body));
  const e = await http('POST', '/finance/entries', token, { entryType: 'DEBIT', nature: 'PAYABLE', amount: 650.37, description: 'HTTP manual', bankAccountId: acc.body.data.id, idempotencyKey: key, costCenterId: cc.body.data && cc.body.data.id });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  const line = await http('POST', '/finance/bank-transactions', token, { bankAccountId: acc.body.data.id, amount: -650.37, transactionDate: new Date().toISOString(), externalTransactionId: key, source: 'WEBHOOK', sourceTrusted: true });
  assert.equal(line.status, 201, JSON.stringify(line.body));
  assert.equal(line.body.data.source, 'MANUAL');
  assert.equal(line.body.data.sourceTrusted, false);
  const r = await http('POST', `/finance/bank-transactions/${line.body.data.id}/auto-reconcile`, token, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.finalClass, 'EXACT');
  assert.equal(r.body.data.autoReconciled, false);
  assert.equal(r.body.data.autoBlockedReason, 'UNTRUSTED_SOURCE');
  const p = await http('GET', '/finance/reconciliation/policy', token);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual(p.body.data, { autoScoreMin: 0.9, suggestionScoreMin: 0.45, dateWindowDays: 3, ambiguityGap: 0.05, autoStrong: false });
  const semLeitura = await http('GET', '/finance/reconciliation/policy', tokenFor(iso, tenant.userId, ['legal:read']));
  assert.equal(semLeitura.status, 403);
});
