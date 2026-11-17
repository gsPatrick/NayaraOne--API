'use strict';

/**
 * Segunda leva (16/11/2026), Lote 7 do plano: item 16 e as partes "A" dos itens 14 e 15a (DI-BI2-6).
 *  - Caderno M4 §19: "Contas 7/30/60 dias", "Recebíveis 7/30/60 dias", "Inadimplência: vencidos/total elegível" — o lançamento PRÓPRIO a
 *    pagar ou a receber exige o vencimento (criação, edição que tenta apagar, excedente classificado como despesa). Dinheiro de terceiro fica fora.
 *  - Caderno M4 §4: "Centro de custo obrigatório para despesa. Centro de resultado obrigatório para receita e análise de margem." — a edição
 *    não apaga o centro e o excedente classificado como receita exige o centro de resultado.
 * Cada caso reprova a forma antiga (o pedido sem o campo passava e gravava o lançamento sem ele).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix, createTestCostCenter, createTestResultCenter } = require('./testHelpers');
const { vencimentoDeTeste } = require('./helpers/vencimentoPadrao');
const financialEntriesService = require('../src/modules/finance/application/services/financial-entry.service');
const receiptService = require('../src/modules/finance/application/services/receipt.service');
const classificationPendings = require('../src/modules/finance/application/services/classification-pending.service');
const financeController = require('../src/modules/finance/presentation/http/finance.controller');
const domain = require('../src/modules/finance/domain/open-entry-required');
const { FinancialEntry } = require('../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const W = (fields) => ({ groupId: tenant.groupId, companyId: tenant.companyId, ...fields });
const AMANHA = () => new Date(new Date(vencimentoDeTeste()).getTime() + 86400000).toISOString();

async function expectCode(promise, code, status) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `esperado ${code}, veio ${err.code}: ${err.message}`);
    if (status) assert.equal(err.statusCode, status);
    return true;
  });
}

async function sqlError(transaction, sql, replacements = {}) {
  try {
    await sequelize.transaction({ transaction }, (sp) => sequelize.query(sql, { replacements, transaction: sp }));
    return null;
  } catch (err) {
    return err;
  }
}

async function payable(t, extra = {}) {
  const cc = await createTestCostCenter(tenant, t);
  return financialEntriesService.createFinancialEntry(W({ entryType: 'DEBIT', nature: 'PAYABLE', amount: 100, costCenterId: cc.id, description: `VENC pagar ${uniqueSuffix()}`, dueAt: vencimentoDeTeste(), ...extra }), tenant.userId, t);
}

async function receivable(t, extra = {}) {
  const rc = await createTestResultCenter(tenant, t);
  return financialEntriesService.createFinancialEntry(W({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 100, resultCenterId: rc.id, description: `VENC receber ${uniqueSuffix()}`, dueAt: vencimentoDeTeste(), ...extra }), tenant.userId, t);
}

/** Excedente de um recebimento: recebível de 100 com baixa de 130 -> pendência de classificação de 30, sem vencimento. */
async function excess(t) {
  const entry = await receivable(t);
  const { classificationPending } = await receiptService.settleFinancialEntryPartial(entry.id, 130, tenant.userId, t);
  assert.equal(classificationPending.dueAt, null, 'o excedente nasce sem vencimento');
  return classificationPending;
}

/** Controller com req/res falsos na mesma transação (rollback): prova a fiação do corpo HTTP até o serviço. */
function callController(handler, { body, params = {} }, transaction) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ statusCode: this.statusCode, body: JSON.parse(JSON.stringify(payload)) }); return this; },
    };
    const req = { body, params, query: {}, headers: {}, auth: { userId: tenant.userId, groupId: tenant.groupId, companyId: tenant.companyId, permissions: [] }, withTenantTransaction: (fn) => fn(transaction) };
    handler(req, res, reject);
  });
}

test('DI-BI2-6 domínio: só a pagar/receber PRÓPRIO exige vencimento; terceiro, ajuste e transferência não', () => {
  assert.equal(domain.isMissingDueDate({ nature: 'PAYABLE', isThirdPartyFunds: false, dueAt: null }), true);
  assert.equal(domain.isMissingDueDate({ nature: 'receivable', isThirdPartyFunds: false, dueAt: '  ' }), true);
  assert.equal(domain.isMissingDueDate({ nature: 'PAYABLE', isThirdPartyFunds: true, dueAt: null }), false, 'repasse/devolução de terceiro fica fora');
  assert.equal(domain.isMissingDueDate({ nature: 'RECEIVABLE', isThirdPartyFunds: true, dueAt: undefined }), false, 'caução fica fora');
  for (const nature of ['ADJUSTMENT', 'TRANSFER', 'PENDING_CLASSIFICATION']) assert.equal(domain.isMissingDueDate({ nature, dueAt: null }), false, nature);
  assert.equal(domain.isMissingDueDate({ nature: 'PAYABLE', dueAt: '2026-11-20' }), false);
  assert.equal(domain.dueDateEdit(null, '2026-11-20T15:00:00.000Z'), 'fill');
  assert.equal(domain.dueDateEdit('2026-11-20T15:00:00.000Z', '2026-11-20T15:00:00.000Z'), 'none');
  assert.equal(domain.dueDateEdit('2026-11-20T15:00:00.000Z', '2026-11-21T15:00:00.000Z'), 'change');
  assert.equal(domain.dueDateEdit('2026-11-20T15:00:00.000Z', null), 'clear');
  assert.equal(domain.dueDateEdit('2026-11-20T15:00:00.000Z', undefined), 'none');
  assert.deepEqual(domain.missingForExcessClassification('PAYABLE', { costCenterId: 'x' }), ['dueAt']);
  assert.deepEqual(domain.missingForExcessClassification('RECEIVABLE', {}), ['resultCenterId']);
  assert.deepEqual(domain.missingForExcessClassification('ADJUSTMENT', {}), []);
});

test('DI-BI2-6 criação: conta a pagar e a receber própria sem vencimento dá 422 FINANCE_ENTRY_DUE_DATE_REQUIRED (serviço e rota)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    for (const dueAt of [undefined, null, '', '   ']) {
      await expectCode(payable(t, { dueAt }), 'FINANCE_ENTRY_DUE_DATE_REQUIRED', 422);
      await expectCode(receivable(t, { dueAt }), 'FINANCE_ENTRY_DUE_DATE_REQUIRED', 422);
    }
    const desc = `VENC rota ${uniqueSuffix()}`;
    const cc = await createTestCostCenter(tenant, t);
    await expectCode(
      callController(financeController.createFinancialEntry, { body: { entryType: 'DEBIT', nature: 'PAYABLE', amount: 10, costCenterId: cc.id, description: desc } }, t),
      'FINANCE_ENTRY_DUE_DATE_REQUIRED', 422
    );
    assert.equal(await FinancialEntry.count({ where: { description: desc }, transaction: t }), 0, 'nada gravado sem vencimento');
    const ok = await callController(financeController.createFinancialEntry, { body: { entryType: 'DEBIT', nature: 'PAYABLE', amount: 10, costCenterId: cc.id, description: desc, dueAt: vencimentoDeTeste() } }, t);
    assert.equal(ok.statusCode, 201);
    assert.ok(ok.body.data.dueAt);
    // Ajuste não é conta a pagar nem a receber: continua aceitando sem vencimento.
    const adj = await financialEntriesService.createFinancialEntry(W({ entryType: 'CREDIT', nature: 'ADJUSTMENT', amount: 5, description: `VENC ajuste ${uniqueSuffix()}` }), tenant.userId, t);
    assert.equal(adj.dueAt, null);
  });
});

test('DI-BI2-6 edição: não apaga o vencimento (422) nem o centro de custo/resultado (400); o vencimento gravado não é trocado (409)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const p = await payable(t);
    const r = await receivable(t);
    for (const dueAt of [null, '', '  ']) {
      await expectCode(financialEntriesService.updateFinancialEntry(p.id, { dueAt }, tenant.userId, t), 'FINANCE_ENTRY_DUE_DATE_REQUIRED', 422);
      await expectCode(financialEntriesService.updateFinancialEntry(r.id, { dueAt }, tenant.userId, t), 'FINANCE_ENTRY_DUE_DATE_REQUIRED', 422);
    }
    for (const costCenterId of [null, '']) {
      await expectCode(financialEntriesService.updateFinancialEntry(p.id, { costCenterId }, tenant.userId, t), 'FINANCE_ENTRY_COST_CENTER_REQUIRED', 400);
    }
    for (const resultCenterId of [null, '']) {
      await expectCode(financialEntriesService.updateFinancialEntry(r.id, { resultCenterId }, tenant.userId, t), 'FINANCE_ENTRY_RESULT_CENTER_REQUIRED', 400);
    }
    // Trocar a data: antes o banco recusava com erro genérico (trigger append-only); agora a resposta é o código da regra.
    await expectCode(financialEntriesService.updateFinancialEntry(p.id, { dueAt: AMANHA() }, tenant.userId, t), 'FINANCE_ENTRY_DUE_DATE_IMMUTABLE', 409);
    // Edição normal, reenviando o mesmo vencimento e trocando os centros por outros, continua valendo.
    const cc2 = await createTestCostCenter(tenant, t);
    const edited = await financialEntriesService.updateFinancialEntry(p.id, { description: 'VENC editada', dueAt: p.dueAt, costCenterId: cc2.id }, tenant.userId, t);
    assert.equal(edited.description, 'VENC editada');
    assert.equal(edited.costCenterId, cc2.id);
    const reread = await FinancialEntry.findByPk(p.id, { transaction: t });
    assert.equal(new Date(reread.dueAt).getTime(), new Date(p.dueAt).getTime());
    assert.equal(reread.costCenterId, cc2.id);
  });
});

test('DI-BI2-6 edição: lançamento antigo sem vencimento recebe a data uma vez; o banco aceita só NULO -> data em PENDING', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const cc = await createTestCostCenter(tenant, t);
    // Lançamento gravado antes da regra (sem vencimento), direto no modelo.
    const legado = await FinancialEntry.create(
      W({ entryType: 'DEBIT', nature: 'PAYABLE', status: 'PENDING', amount: 20, costCenterId: cc.id, description: `VENC legado ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId }),
      { transaction: t }
    );
    const filled = await financialEntriesService.updateFinancialEntry(legado.id, { dueAt: vencimentoDeTeste() }, tenant.userId, t);
    assert.equal(new Date(filled.dueAt).toISOString(), new Date(vencimentoDeTeste()).toISOString());
    // Depois de preenchida, a data não troca nem some, nem por UPDATE direto no banco.
    const change = await sqlError(t, "UPDATE finance.financial_entries SET due_at = due_at + interval '1 day' WHERE id = :id", { id: legado.id });
    assert.ok(change && /append-only.*"due_at"/.test(change.message), String(change && change.message));
    const clear = await sqlError(t, 'UPDATE finance.financial_entries SET due_at = NULL WHERE id = :id', { id: legado.id });
    assert.ok(clear && /append-only.*"due_at"/.test(clear.message), String(clear && clear.message));
    // Lançamento já liquidado sem vencimento: o banco não deixa preencher (só em aberto).
    const liquidado = await FinancialEntry.create(
      W({ entryType: 'CREDIT', nature: 'ADJUSTMENT', status: 'SETTLED', settledAt: new Date(), amount: 5, description: `VENC liquidado ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId }),
      { transaction: t }
    );
    const late = await sqlError(t, 'UPDATE finance.financial_entries SET due_at = now() WHERE id = :id', { id: liquidado.id });
    assert.ok(late && /append-only.*"due_at"/.test(late.message), String(late && late.message));
  });
});

test('DI-BI2-6 excedente classificado como receita exige o centro de resultado (da própria empresa) e grava o centro', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const pending = await excess(t);
    await expectCode(classificationPendings.resolveClassificationPending(pending.id, 'RECEIVABLE', tenant.userId, t), 'FINANCE_ENTRY_RESULT_CENTER_REQUIRED', 400);
    await expectCode(
      classificationPendings.resolveClassificationPending(pending.id, 'RECEIVABLE', tenant.userId, t, { resultCenterId: '00000000-0000-4000-8000-000000000000' }),
      'FINANCE_RESULT_CENTER_NOT_FOUND', 404
    );
    const rc = await createTestResultCenter(tenant, t);
    const { statusCode, body } = await callController(
      financeController.resolveFinancialEntryClassificationPending,
      { params: { id: pending.id }, body: { finalNature: 'RECEIVABLE', resultCenterId: rc.id } },
      t
    );
    assert.equal(statusCode, 200);
    assert.equal(body.data.nature, 'RECEIVABLE');
    assert.equal(body.data.status, 'SETTLED');
    assert.equal(body.data.resultCenterId, rc.id, 'a rota repassa o centro de resultado e ele é gravado');
  });
});

test('DI-BI2-6 excedente classificado como despesa exige o vencimento (422) e o grava; conta fica PENDING com o centro de custo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const pending = await excess(t);
    const cc = await createTestCostCenter(tenant, t);
    await expectCode(classificationPendings.resolveClassificationPending(pending.id, 'PAYABLE', tenant.userId, t, { costCenterId: cc.id }), 'FINANCE_ENTRY_DUE_DATE_REQUIRED', 422);
    await expectCode(
      classificationPendings.resolveClassificationPending(pending.id, 'PAYABLE', tenant.userId, t, { costCenterId: cc.id, dueAt: '92026-01-10' }),
      'FINANCE_ENTRY_VALIDATION', 400
    );
    await expectCode(
      classificationPendings.resolveClassificationPending(pending.id, 'PAYABLE', tenant.userId, t, { costCenterId: '00000000-0000-4000-8000-000000000000', dueAt: vencimentoDeTeste() }),
      'FINANCE_COST_CENTER_NOT_FOUND', 404
    );
    const { statusCode, body } = await callController(
      financeController.resolveFinancialEntryClassificationPending,
      { params: { id: pending.id }, body: { finalNature: 'PAYABLE', costCenterId: cc.id, dueAt: vencimentoDeTeste() } },
      t
    );
    assert.equal(statusCode, 200);
    assert.equal(body.data.nature, 'PAYABLE');
    assert.equal(body.data.status, 'PENDING');
    assert.equal(body.data.costCenterId, cc.id);
    const reread = await FinancialEntry.findByPk(pending.id, { transaction: t });
    assert.equal(new Date(reread.dueAt).toISOString(), new Date(vencimentoDeTeste()).toISOString(), 'o vencimento da rota é gravado no banco');
  });
});
