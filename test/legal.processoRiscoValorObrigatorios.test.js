'use strict';

/**
 * Risco e valor estimado do processo (Caderno M5:244 "Processo tem número, órgão, classe, status, partes, valor, risco e
 * responsável"; M5:250 o valor é a estimativa processual). Antes o processo nascia sem os dois e a edição aceitava apagar
 * (null); agora a criação exige os dois (422) e a edição não apaga. Valor 0 é aceito (processo consultivo, DI-BI2-1).
 * Postgres real com RLS, tudo em transação desfeita no fim.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const legalCasesService = require('../src/modules/legal/cases/legal-case.service');
const { LegalCase } = require('../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const recusa = (code) => (err) => {
  assert.equal(err.code, code);
  assert.equal(err.statusCode, 422);
  return true;
};
const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', summary: `Risco e valor ${uniqueSuffix()}` });
const criar = (payload, t) => legalCasesService.createLegalCase({ ...base(), ...payload }, tenant.userId, t);

test('M5:244 criação: sem risco ou sem valor estimado o processo não nasce (422)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const antes = await LegalCase.count({ transaction: t });
    await assert.rejects(criar({ estimatedAmount: '1000.00' }, t), recusa('LEGAL_CASE_RISK_REQUIRED'));
    await assert.rejects(criar({ riskLevel: null, estimatedAmount: '1000.00' }, t), recusa('LEGAL_CASE_RISK_REQUIRED'));
    await assert.rejects(criar({ riskLevel: '  ', estimatedAmount: '1000.00' }, t), recusa('LEGAL_CASE_RISK_REQUIRED'));
    await assert.rejects(criar({ riskLevel: 'HIGH' }, t), recusa('LEGAL_CASE_ESTIMATED_AMOUNT_REQUIRED'));
    await assert.rejects(criar({ riskLevel: 'HIGH', estimatedAmount: null }, t), recusa('LEGAL_CASE_ESTIMATED_AMOUNT_REQUIRED'));
    await assert.rejects(criar({ riskLevel: 'HIGH', estimatedAmount: '' }, t), recusa('LEGAL_CASE_ESTIMATED_AMOUNT_REQUIRED'));
    await assert.rejects(criar({}, t), recusa('LEGAL_CASE_RISK_REQUIRED'));
    assert.equal(await LegalCase.count({ transaction: t }), antes, 'nenhum processo gravado nas recusas');
    // O formato continua validado depois da presença: risco fora da lista e valor negativo são 400.
    await assert.rejects(criar({ riskLevel: 'ALTISSIMO', estimatedAmount: '10' }, t), (e) => e.code === 'LEGAL_CASE_VALIDATION');
    await assert.rejects(criar({ riskLevel: 'LOW', estimatedAmount: -1 }, t), (e) => e.code === 'LEGAL_CASE_VALIDATION');
  });
});

test('M5:244 criação: valor 0 é aceito (processo consultivo sem valor em disputa, DI-BI2-1)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const consultivo = await criar({ caseType: 'CONSULTATIVE', riskLevel: 'low', estimatedAmount: 0 }, t);
    const salvo = await LegalCase.findByPk(consultivo.id, { transaction: t });
    assert.equal(salvo.riskLevel, 'LOW');
    assert.equal(salvo.estimatedAmount, '0.00');
    const textoZero = await criar({ riskLevel: 'MEDIUM', estimatedAmount: '0' }, t);
    assert.equal((await LegalCase.findByPk(textoZero.id, { transaction: t })).estimatedAmount, '0.00');
  });
});

test('M5:244 edição: risco e valor estimado não são apagados (null ou vazio dá 422); omitir mantém', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const legalCase = await criar({ riskLevel: 'HIGH', estimatedAmount: '15000.00' }, t);
    const atualizar = (payload) => legalCasesService.updateLegalCase(legalCase.id, payload, tenant.userId, t);
    await assert.rejects(atualizar({ riskLevel: null }), recusa('LEGAL_CASE_RISK_REQUIRED'));
    await assert.rejects(atualizar({ riskLevel: '' }), recusa('LEGAL_CASE_RISK_REQUIRED'));
    await assert.rejects(atualizar({ estimatedAmount: null }), recusa('LEGAL_CASE_ESTIMATED_AMOUNT_REQUIRED'));
    await assert.rejects(atualizar({ estimatedAmount: '' }), recusa('LEGAL_CASE_ESTIMATED_AMOUNT_REQUIRED'));
    await assert.rejects(atualizar({ summary: 'Só o resumo', estimatedAmount: null }), recusa('LEGAL_CASE_ESTIMATED_AMOUNT_REQUIRED'));
    let salvo = await LegalCase.findByPk(legalCase.id, { transaction: t });
    assert.deepEqual([salvo.riskLevel, salvo.estimatedAmount, salvo.summary !== 'Só o resumo'], ['HIGH', '15000.00', true], 'nada gravado nas recusas');

    // Omitir os campos (editar outra coisa) mantém o que está gravado; trocar por outro valor válido, inclusive 0, passa.
    await atualizar({ summary: 'Resumo novo' });
    await atualizar({ riskLevel: 'CRITICAL', estimatedAmount: 0 });
    salvo = await LegalCase.findByPk(legalCase.id, { transaction: t });
    assert.deepEqual([salvo.riskLevel, salvo.estimatedAmount, salvo.summary], ['CRITICAL', '0.00', 'Resumo novo']);
    // O valor confirmado continua opcional e apagável (só a estimativa e o risco são obrigatórios).
    await atualizar({ confirmedAmount: '500' });
    await atualizar({ confirmedAmount: null });
    assert.equal((await LegalCase.findByPk(legalCase.id, { transaction: t })).confirmedAmount, null);
  });
});
