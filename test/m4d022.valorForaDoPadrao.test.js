'use strict';

// M4-D022 item 5 e seção 8, testes 5, 6, 9, 11, 13 e 14 (DEC-007; DI-DEC007-3): "Valor fora do padrão" compara o valor com a MEDIANA dos pagamentos
// liquidados da mesma categoria e do mesmo favorecido nos últimos `antifraude.outlier_historico_meses` meses (12); com menos de
// `antifraude.outlier_amostra_minima` (5) usa a categoria inteira da empresa; se nem ela tiver o mínimo, não pontua. 3,0x => AMOUNT_OUTLIER MEDIUM
// (revisão); 10,0x => HIGH, que bloqueia. Falha do cálculo => restrição máxima (HIGH, bloqueante). Serviço real, empresas isoladas do banco descartável.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const T = require('./testHelpers');
const { isolatedTenant, closeIsolated } = require('./helpers/m4FinanceHttp');
const { gravarParametro } = require('./helpers/mfaRecente');
const { kit } = require('./helpers/antifraudeDec007');
const gate = require('../src/modules/finance/application/services/payment-anomaly-gate');
const { FinancialEntry, TenantSetting } = require('../src/models');

let tenant;
let other;
let costCenterId;
const K = kit(() => tenant);
const rollback = (fn) => T.withRollbackTenantTransaction(tenant, fn);
const pay = (t, amount, extra = {}) => K.payable(t, amount, { costCenterId, ...extra });
const blocks = (entry, t) => assert.rejects(gate.evaluateAndAssertPreparable(entry, t), (err) => err.code === 'FINANCE_AMOUNT_OUTLIER_REVIEW_REQUIRED');

before(async () => {
  tenant = await isolatedTenant('m4d022-outlier');
  other = await isolatedTenant('m4d022-outlier-b');
  await T.withTenantTransaction(tenant, async (t) => { costCenterId = (await T.createTestCostCenter(tenant, t)).id; });
});

after(async () => {
  await closeIsolated();
  await T.sequelize.close();
});

test('m4d022_score_fronteiras_3_e_10_sobre_a_mediana: mediana 2.000 (média 3.400): 7.000 = 3,5 MEDIUM revisa; 25.000 = 12,5 HIGH bloqueia', async () => {
  await rollback(async (t) => {
    const acc = await K.account(t);
    await K.settled(t, acc.id, ['1000.00', '2000.00', '2000.00', '3000.00', '9000.00'], { costCenterId }); // mediana 2.000; média 3.400
    assert.equal((await pay(t, '5999.99', { bankAccountId: acc.id })).requiresManualReview, false, '2,99x');
    const at3 = await pay(t, '6000.00', { bankAccountId: acc.id });
    assert.deepEqual(await K.casesOf(t, at3.id), ['AMOUNT_OUTLIER:MEDIUM'], '3,0x exato revisa');
    const ex = await pay(t, '7000.00', { bankAccountId: acc.id });
    assert.deepEqual(await K.casesOf(t, ex.id), ['AMOUNT_OUTLIER:MEDIUM'], 'exemplo da M4-D022: 3,5 => MEDIUM (pela média seria 2,06 e passaria)');
    assert.match(ex.manualReviewReason, /Valor 7000\.00 é 3\.5x a mediana \(2000\.00\) dos 5 pagamentos já liquidados a esta conta bancária da mesma categoria do plano de contas nos últimos 12 meses \(limiar: 3x revisa, 10x bloqueia\)\.$/);
    await gate.evaluateAndAssertPreparable(ex, t); // MEDIUM não bloqueia preparar
    assert.deepEqual(await K.casesOf(t, (await pay(t, '19999.99', { bankAccountId: acc.id })).id), ['AMOUNT_OUTLIER:MEDIUM'], '9,99x');
    const at10 = await pay(t, '20000.00', { bankAccountId: acc.id });
    assert.ok((await K.casesOf(t, at10.id)).includes('AMOUNT_OUTLIER:HIGH'), '10,0x exato bloqueia');
    const big = await pay(t, '25000.00', { bankAccountId: acc.id });
    assert.ok((await K.casesOf(t, big.id)).includes('AMOUNT_OUTLIER:HIGH'));
    assert.match(big.manualReviewReason, /12\.5x a mediana \(2000\.00\).*O pagamento fica bloqueado até a revisão/);
    await blocks(big, t);
  });
});

test('m4d022_menos_de_5_amostras_nao_pontua: com 4 do favorecido e 4 na categoria não pontua; a 5ª da categoria (outro favorecido) passa a conferir pela categoria da empresa', async () => {
  await rollback(async (t) => {
    const acc = await K.account(t);
    await K.settled(t, acc.id, ['100.00', '100.00', '100.00', '100.00'], { costCenterId });
    const none = await pay(t, '3000.00', { bankAccountId: acc.id });
    assert.equal(none.requiresManualReview, false, '30x, mas sem o mínimo de amostras nem no favorecido nem na categoria');
    await K.settled(t, (await K.account(t)).id, ['100.00'], { costCenterId });
    const scored = await pay(t, '3000.01', { bankAccountId: acc.id });
    assert.deepEqual(await K.casesOf(t, scored.id), ['AMOUNT_OUTLIER:HIGH']);
    assert.match(scored.manualReviewReason, /dos 5 pagamentos já liquidados pela empresa da mesma categoria do plano de contas \(esta conta tem 4, menos que o mínimo de 5\)/);
    // A conta SEM nenhum histórico também é conferida pela categoria da empresa (nenhuma conta sai da conferência).
    const fresh = await pay(t, '3000.02', { bankAccountId: (await K.account(t)).id });
    assert.ok((await K.casesOf(t, fresh.id)).includes('AMOUNT_OUTLIER:HIGH'));
  });
});

test('m4d022_param_antifraude_outlier_amostra_minima_muda_comportamento: 3 amostras não pontuam com o padrão 5; com 3, pontuam', async () => {
  await rollback(async (t) => {
    const acc = await K.account(t);
    await K.settled(t, acc.id, ['500.00', '500.00', '500.00'], { costCenterId });
    assert.equal((await pay(t, '2000.00', { bankAccountId: acc.id })).requiresManualReview, false);
    await gravarParametro('antifraude.outlier_amostra_minima', 3, tenant, t);
    assert.deepEqual(await K.casesOf(t, (await pay(t, '2000.01', { bankAccountId: acc.id })).id), ['AMOUNT_OUTLIER:MEDIUM']);
  });
  for (const value of [0, 101, 2.5]) {
    await rollback((t) => assert.rejects(gravarParametro('antifraude.outlier_amostra_minima', value, tenant, t), (err) => err.statusCode === 422));
  }
});

test('m4d022_param_antifraude_outlier_historico_meses_muda_comportamento: pagamentos de 6 meses atrás contam com 12 meses e não contam com 3', async () => {
  await rollback(async (t) => {
    const acc = await K.account(t);
    await K.settled(t, acc.id, ['500.00', '500.00', '500.00', '500.00', '500.00'], { costCenterId, monthsAgo: 6 });
    assert.deepEqual(await K.casesOf(t, (await pay(t, '2000.00', { bankAccountId: acc.id })).id), ['AMOUNT_OUTLIER:MEDIUM']);
    await gravarParametro('antifraude.outlier_historico_meses', 3, tenant, t);
    assert.equal((await pay(t, '2000.01', { bankAccountId: acc.id })).requiresManualReview, false, 'fora dos 3 meses o histórico não tem o mínimo');
  });
  for (const value of [0, 61, 1.5]) {
    await rollback((t) => assert.rejects(gravarParametro('antifraude.outlier_historico_meses', value, tenant, t), (err) => err.statusCode === 422));
  }
});

test('m4d022_falha_do_calculo_assume_restricao_maxima: erro ao ler o histórico retém e bloqueia (HIGH), e a transação segue utilizável', async () => {
  await rollback(async (t) => {
    const acc = await K.account(t);
    const original = FinancialEntry.findAll;
    FinancialEntry.findAll = async function quebrado(opts) {
      if (opts && Array.isArray(opts.attributes) && opts.attributes.includes('amount')) throw new Error('histórico indisponível (teste)');
      return original.call(this, opts);
    };
    let entry;
    try {
      entry = await pay(t, '100.00', { bankAccountId: acc.id });
    } finally {
      FinancialEntry.findAll = original;
    }
    assert.equal(entry.requiresManualReview, true);
    assert.deepEqual(await K.casesOf(t, entry.id), ['AMOUNT_OUTLIER:HIGH']);
    assert.match(entry.manualReviewReason, /Não foi possível conferir "valor fora do padrão" \(histórico indisponível \(teste\)\)\. Por segurança o pagamento fica retido e bloqueado até a revisão\./);
    await blocks(entry, t);
    assert.ok(await TenantSetting.count({ transaction: t }) >= 0, 'a transação continua utilizável depois da falha (SAVEPOINT)');
  });
});

test('m4d022_empresa_B_nao_afeta_o_historico_da_A: o histórico de outra empresa não entra na mediana', async () => {
  await T.withTenantTransaction(other, async (t) => {
    const cc = await T.createTestCostCenter(other, t);
    const Kb = kit(() => other);
    const accB = await Kb.account(t);
    await Kb.settled(t, accB.id, ['10.00', '10.00', '10.00', '10.00', '10.00', '10.00'], { costCenterId: cc.id });
  });
  await rollback(async (t) => {
    const fresh = await pay(t, '3000.00', { bankAccountId: (await K.account(t)).id });
    assert.equal(fresh.requiresManualReview, false, 'a empresa A não tem histórico na categoria: não pontua (a B não conta)');
  });
});
