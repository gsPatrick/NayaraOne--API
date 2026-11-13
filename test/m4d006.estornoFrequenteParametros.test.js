'use strict';

// M4-D006 item 9 e seção 8, testes 15 e 16 (DEC-007; DI-DEC007-2 e DI-DEC007-6): estorno frequente abre anomaly_case MEDIUM quando a mesma pessoa chega a
// `antifraude.estorno_frequente_usuario_30d` (padrão 3) ou a empresa chega a `antifraude.estorno_frequente_empresa_30d` (padrão 5, o da DEC-007; antes o
// código usava 3) estornos em 30 dias. A empresa que gravou 3 na tela continua com 3. Valor fora da faixa é recusado com 422. Serviço real, empresa
// isolada do banco descartável, cada caso numa transação desfeita.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const T = require('./testHelpers');
const { isolatedTenant, closeIsolated } = require('./helpers/m4FinanceHttp');
const { kit } = require('./helpers/antifraudeDec007');
const settingsService = require('../src/features/settings/settings.service');
const receiptService = require('../src/modules/finance/application/services/receipt.service');
const { AnomalyCase, FinancialEntry, User } = require('../src/models');

let tenant;
let resultCenterId;
const users = [];
const K = kit(() => tenant);
const rollback = (fn) => T.withRollbackTenantTransaction(tenant, fn);
const set = (t, key, value) => settingsService.upsertSetting(key, value, tenant, tenant.userId, t);

before(async () => {
  tenant = await isolatedTenant('m4d006-estorno');
  for (let i = 0; i < 5; i += 1) users.push((await User.create({ email: `m4d006-${i}-${T.uniqueSuffix()}@nayaraone.dev`, name: `M4-D006 ${i}`, passwordHash: 'x', status: 'ACTIVE' })).id);
  await T.withTenantTransaction(tenant, async (t) => { resultCenterId = (await T.createTestResultCenter(tenant, t)).id; });
});

after(async () => {
  await closeIsolated();
  await T.sequelize.close();
});

const reversible = (t) => FinancialEntry.create({ ...K.base(), resultCenterId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: '50.00', description: `estorno ${T.uniqueSuffix()}`, status: 'SETTLED', settledAt: new Date(), competenceMonth: new Date().toISOString().slice(0, 7) }, { transaction: t });
const reverse = async (t, actor, i) => receiptService.reverseFinancialEntry((await reversible(t)).id, `estorno de teste ${i}`, actor, t);
const cases = async (t) => (await AnomalyCase.findAll({ where: { caseType: 'FREQUENT_REVERSAL', status: 'OPEN' }, transaction: t })).map((c) => c.riskLevel);
const rejects422 = (key, value) => rollback((t) => assert.rejects(set(t, key, value), (err) => err.statusCode === 422 && err.code === 'SETTING_INVALID_VALUE'));

test('m4d006_param_antifraude_estorno_frequente_usuario_30d_muda_comportamento: o 3º da mesma pessoa abre MEDIUM; com 5, só o 5º', async () => {
  await rollback(async (t) => {
    await set(t, 'antifraude.estorno_frequente_empresa_30d', 1000);
    for (let i = 0; i < 2; i += 1) await reverse(t, users[0], i);
    assert.deepEqual(await cases(t), []);
    await reverse(t, users[0], 2);
    assert.deepEqual(await cases(t), ['MEDIUM']);
  });
  await rollback(async (t) => {
    await set(t, 'antifraude.estorno_frequente_empresa_30d', 1000);
    await set(t, 'antifraude.estorno_frequente_usuario_30d', 5);
    for (let i = 0; i < 4; i += 1) await reverse(t, users[0], i);
    assert.deepEqual(await cases(t), [], 'com 5, o 3º e o 4º não abrem');
    await reverse(t, users[0], 4);
    assert.deepEqual(await cases(t), ['MEDIUM']);
  });
  for (const value of [0, 101]) await rejects422('antifraude.estorno_frequente_usuario_30d', value);
});

test('m4d006_param_antifraude_estorno_frequente_empresa_30d_muda_comportamento: padrão 5 da DEC-007 (4 de pessoas diferentes não abrem; o 5º abre MEDIUM); empresa com 3 gravado continua com 3', async () => {
  await rollback(async (t) => {
    await set(t, 'antifraude.estorno_frequente_usuario_30d', 100);
    for (let i = 0; i < 4; i += 1) await reverse(t, users[i], i);
    assert.deepEqual(await cases(t), [], 'padrão 5: 4 estornos na empresa não abrem caso');
    await reverse(t, users[4], 4);
    assert.deepEqual(await cases(t), ['MEDIUM'], 'o 5º abre');
  });
  await rollback(async (t) => {
    await set(t, 'antifraude.estorno_frequente_usuario_30d', 100);
    await set(t, 'antifraude.estorno_frequente_empresa_30d', 3); // valor que a empresa gravou de propósito: não muda com o padrão novo
    for (let i = 0; i < 3; i += 1) await reverse(t, users[i], i);
    assert.deepEqual(await cases(t), ['MEDIUM'], 'com 3 gravado, o 3º abre');
  });
  for (const value of [0, 1001]) await rejects422('antifraude.estorno_frequente_empresa_30d', value);
});
