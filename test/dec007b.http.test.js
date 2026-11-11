'use strict';

// DEC-007, rodada 2 — HTTP real contra o app (empresa isolada do banco descartável; MFA recente por linhas no banco, nunca pelo endpoint de MFA):
//  - DI-DEC007-5: o 409 na preparação (POST /finance/payments/prepare) e no pedido de aprovação (POST /finance/approval-requests) de um pagamento ainda
//    não avaliado desfaz a transação da requisição, mas a retenção e o caso do antifraude ficam gravados (transação separada depois do rollback);
//  - DI-DEC007-2: PUT /settings/:key fora da faixa responde 422 SETTING_INVALID_VALUE com a frase do rótulo, sem gravar; GET /finance/antifraud/parameters
//    devolve o valor em vigor de cada parâmetro (gravado, padrão ou padrão no lugar de um gravado inválido) para a tela.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.DEC007B_409_HTTP_TEST_PORT || '38991';
require('../app');
const T = require('./testHelpers');
const { createUser, tokenFor, client, isolatedTenant, closeIsolated, FINANCE_ALL } = require('./helpers/m4FinanceHttp');
const { kit } = require('./helpers/antifraudeDec007');
const { AnomalyCase, FinancialEntry, TenantSetting } = require('../src/models');

let tenant;
let http;
let maker;
let admin;
let costCenterId;
const K = kit(() => tenant);
const inTenant = (fn) => T.withTenantTransaction(tenant, fn);

before(async () => {
  tenant = await isolatedTenant('dec007b-http');
  http = client(`http://127.0.0.1:${process.env.PORT}/api/v1`);
  maker = tokenFor(tenant, (await createUser(tenant, 'dec007b-preparador')).id);
  admin = tokenFor(tenant, (await createUser(tenant, 'dec007b-admin')).id, [...FINANCE_ALL, 'settings:read', 'settings:update']);
  costCenterId = await inTenant(async (t) => (await T.createTestCostCenter(tenant, t)).id);
  await new Promise((r) => setTimeout(r, 300));
});

after(async () => {
  await closeIsolated();
  await T.sequelize.close();
  process.exit(0);
});

/** Par igual (mesmo favorecido, valor e vencimento) que nasceu sem avaliação (legado/outro módulo): o primeiro já existe, o segundo é avaliado na preparação. */
async function legacyTwin(amount) {
  return inTenant(async (t) => {
    const acc = await K.account(t);
    const row = (desc) => FinancialEntry.create({ ...K.base(), bankAccountId: acc.id, costCenterId, entryType: 'DEBIT', nature: 'PAYABLE', amount, dueAt: '2027-08-10T15:00:00.000Z', description: `${desc} ${T.uniqueSuffix()}`, status: 'PENDING', competenceMonth: '2027-08' }, { transaction: t });
    await row('legado original');
    return row('legado em dobro');
  });
}
const persisted = (id) => inTenant(async (t) => ({
  entry: await FinancialEntry.findByPk(id, { transaction: t }),
  cases: (await AnomalyCase.findAll({ where: { relatedEntityId: id }, transaction: t })).map((c) => `${c.caseType}:${c.riskLevel}:${c.status}`),
}));

test('dec007b_409_na_preparacao_mantem_o_caso_do_antifraude_gravado (DI-DEC007-5)', async () => {
  const twin = await legacyTwin('1234.00');
  assert.equal(twin.requiresManualReview, false, 'nasceu sem avaliação');
  const res = await http('POST', '/finance/payments/prepare', maker, { financialEntryId: twin.id });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.code, 'FINANCE_DUPLICATE_PAYMENT_SUSPECT');
  const after409 = await persisted(twin.id);
  assert.equal(after409.entry.requiresManualReview, true, 'a retenção sobreviveu ao rollback da requisição');
  assert.deepEqual(after409.cases, ['DUPLICATE_PAYMENT_SUSPECT:HIGH:OPEN'], 'o caso ficou gravado');
  const again = await http('POST', '/finance/payments/prepare', maker, { financialEntryId: twin.id });
  assert.equal(again.code, 'FINANCE_DUPLICATE_PAYMENT_SUSPECT', 'continua bloqueado');
  assert.equal((await persisted(twin.id)).cases.length, 1, 'sem caso repetido');
});

test('dec007b_409_no_pedido_de_aprovacao_mantem_o_caso_do_antifraude_gravado (DI-DEC007-5)', async () => {
  const twin = await legacyTwin('2345.00');
  const res = await http('POST', '/finance/approval-requests', maker, { relatedEntityType: 'FinancialEntry', relatedEntityId: twin.id, riskLevel: 'MEDIUM' });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.code, 'FINANCE_DUPLICATE_PAYMENT_SUSPECT');
  const after409 = await persisted(twin.id);
  assert.equal(after409.entry.requiresManualReview, true);
  assert.deepEqual(after409.cases, ['DUPLICATE_PAYMENT_SUSPECT:HIGH:OPEN']);
});

test('dec007b_put_settings_fora_da_faixa_responde_422_com_a_frase_do_rotulo_e_nao_grava', async () => {
  for (const [key, value, frase] of [
    ['antifraude.duplicidade_janela_dias', 0, /"Pagamento duplicado: janela de dias" deve ser um número inteiro de 1 a 365\. O valor enviado \(0\) foi recusado e nada foi gravado\./],
    ['antifraude.outlier_amostra_minima', 101, /"Valor fora do padrão: mínimo de pagamentos no histórico" deve ser um número inteiro de 1 a 100/],
    ['antifraude.fornecedor_novo_valor_minimo', 0, /"Fornecedor novo: valor a partir do qual exige verificação" deve ser um número de 0,01 a 999\.999\.999,99/],
  ]) {
    const res = await http('PUT', `/settings/${encodeURIComponent(key)}`, admin, { value });
    assert.equal(res.status, 422, `${key}: ${JSON.stringify(res.body)}`);
    assert.equal(res.code, 'SETTING_INVALID_VALUE');
    assert.match(res.body.error.message, frase);
    assert.equal(await inTenant((t) => TenantSetting.count({ where: { companyId: tenant.companyId, key }, transaction: t })), 0);
  }
});

test('dec007b_get_parametros_do_antifraude_mostra_o_valor_em_vigor (gravado, padrão ou padrão no lugar do gravado inválido)', async () => {
  const ok = await http('PUT', '/settings/antifraude.duplicidade_janela_dias', admin, { value: 120 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  await inTenant((t) => K.store(t, 'antifraude.fornecedor_novo_dias', ''));
  const res = await http('GET', '/finance/antifraud/parameters', admin);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const byKey = Object.fromEntries(res.body.data.map((r) => [r.key, r]));
  assert.deepEqual([byKey['antifraude.duplicidade_janela_dias'].effectiveValue, byKey['antifraude.duplicidade_janela_dias'].source], [120, 'STORED']);
  assert.deepEqual([byKey['antifraude.fornecedor_novo_dias'].effectiveValue, byKey['antifraude.fornecedor_novo_dias'].storedValue, byKey['antifraude.fornecedor_novo_dias'].source], [30, '', 'INVALID_STORED']);
  assert.deepEqual([byKey['antifraude.estorno_frequente_empresa_30d'].effectiveValue, byKey['antifraude.estorno_frequente_empresa_30d'].source], [5, 'DEFAULT']);
  for (const key of ['antifraude.outlier_amostra_minima', 'antifraude.outlier_historico_meses']) assert.ok(byKey[key], key);
  const semPermissao = tokenFor(tenant, (await createUser(tenant, 'dec007b-sem-settings')).id, FINANCE_ALL);
  assert.equal((await http('GET', '/finance/antifraud/parameters', semPermissao)).status, 403);
});
