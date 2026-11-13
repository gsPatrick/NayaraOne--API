'use strict';

// DEC-007, rodada 2 (verificação dec007-mfa.md: AF-01, AF-07 e DI-01). Falha segura de verdade em TODOS os parâmetros do antifraude: o valor gravado que
// não é número válido dentro da faixa do catálogo ("", false, [], 0 quando 0 não vale, negativo, texto, objeto, fora da faixa, fração em chave inteira)
// vale como o padrão da DEC-007, por um único leitor (finance-settings.js readFinanceNumber). A gravação fora da faixa é recusada com 422
// SETTING_INVALID_VALUE e a frase do rótulo do catálogo, sem gravar nada. No fluxo real, a duplicidade (AF-01) e o fornecedor novo (AF-07) continuam
// conferindo com o valor ruim gravado. Serviço real, empresa isolada do banco descartável, cada caso numa transação desfeita.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const T = require('./testHelpers');
const { isolatedTenant, closeIsolated } = require('./helpers/m4FinanceHttp');
const { gravarParametro } = require('./helpers/mfaRecente');
const { CATALOGO, invalidStoredValues, kit } = require('./helpers/antifraudeDec007');
const { readFinanceNumber } = require('../src/modules/finance/application/services/finance-settings');
const { TenantSetting } = require('../src/models');

let tenant;
let costCenterId;
const K = kit(() => tenant);
const rollback = (fn) => T.withRollbackTenantTransaction(tenant, fn);

before(async () => {
  tenant = await isolatedTenant('dec007b-falha-segura');
  await T.withTenantTransaction(tenant, async (t) => { costCenterId = (await T.createTestCostCenter(tenant, t)).id; });
});

after(async () => {
  await closeIsolated();
  await T.sequelize.close();
});

test('dec007b_valor_gravado_invalido_vale_o_padrao_em_todos_os_parametros: "", false, [], 0 fora da faixa, negativo, texto e objeto viram o padrão da DEC-007', async () => {
  const wrong = [];
  for (const key of Object.keys(CATALOGO)) {
    const [padrao, min, max] = CATALOGO[key];
    for (const value of invalidStoredValues(key)) {
      await rollback(async (t) => {
        await K.store(t, key, value);
        const lido = await readFinanceNumber(key, tenant, t);
        if (lido !== padrao) wrong.push(`${key}=${JSON.stringify(value)} -> ${JSON.stringify(lido)} (padrão ${padrao})`);
      });
    }
    // A faixa é fechada: o mínimo e o máximo gravados valem como gravados.
    for (const value of [min, max]) {
      await rollback(async (t) => {
        await K.store(t, key, value);
        const lido = await readFinanceNumber(key, tenant, t);
        if (lido !== value) wrong.push(`${key}=${value} (válido) -> ${lido}`);
      });
    }
    await rollback(async (t) => assert.equal(await readFinanceNumber(key, tenant, t), padrao, `${key} sem nada gravado`));
  }
  assert.deepEqual(wrong, [], wrong.join('\n'));
});

test('dec007b_api_recusa_fora_da_faixa_com_422_e_frase_clara: nada é gravado e a frase traz o rótulo e a faixa do catálogo', async () => {
  const wrong = [];
  for (const key of Object.keys(CATALOGO)) {
    const [, min, max, integer, label] = CATALOGO[key];
    const bad = [min - 1, max + 1, String(min + 1), true, ...(integer ? [min + 0.5] : [])];
    for (const value of bad) {
      await rollback(async (t) => {
        try {
          await gravarParametro(key, value, tenant, t);
          wrong.push(`${key}=${JSON.stringify(value)} aceito`);
        } catch (err) {
          if (err.statusCode !== 422 || err.code !== 'SETTING_INVALID_VALUE') wrong.push(`${key}=${JSON.stringify(value)}: ${err.statusCode} ${err.code} ${err.message}`);
          else if (!err.message.includes(`"${label}"`) || !/de [\d.,]+ a [\d.,]+/.test(err.message) || !/nada foi gravado/.test(err.message)) wrong.push(`${key}: frase "${err.message}"`);
        }
        const row = await TenantSetting.findOne({ where: { companyId: tenant.companyId, key }, transaction: t });
        if (row) wrong.push(`${key}=${JSON.stringify(value)} gravou ${JSON.stringify(row.value)}`);
      });
    }
  }
  assert.deepEqual(wrong, [], wrong.join('\n'));
  // A trava entre os múltiplos ("não menor que o múltiplo de revisão") também responde 422, com o número em vigor.
  await rollback(async (t) => {
    await assert.rejects(gravarParametro('antifraude.outlier_bloqueio_multiplicador', 2.5, tenant, t), (err) => {
      assert.equal(err.statusCode, 422);
      assert.match(err.message, /"Valor fora do padrão: múltiplo que bloqueia" deve ser maior ou igual a 3, o múltiplo que manda para revisão/);
      return true;
    });
  });
});

test('dec007b_duplicidade_com_janela_gravada_invalida_continua_retendo (AF-01): com "", false, [], 0 ou -5 gravado, o par igual é retido pelos 90 dias do padrão', async () => {
  for (const value of ['', false, [], 0, -5]) {
    await rollback(async (t) => {
      await K.store(t, 'antifraude.duplicidade_janela_dias', value);
      const acc = await K.account(t);
      const due = '2027-05-10T15:00:00.000Z';
      assert.equal((await K.payable(t, '640.00', { bankAccountId: acc.id, costCenterId, dueAt: due })).requiresManualReview, false);
      const twin = await K.payable(t, '640.00', { bankAccountId: acc.id, costCenterId, dueAt: due });
      assert.equal(twin.requiresManualReview, true, `janela gravada ${JSON.stringify(value)}: o par igual tem de ser retido`);
      assert.deepEqual(await K.casesOf(t, twin.id), ['DUPLICATE_PAYMENT_SUSPECT:HIGH']);
      assert.match(twin.manualReviewReason, /cadastrado nos últimos 90 dias/);
    });
  }
});

test('dec007b_fornecedor_novo_com_dias_gravados_invalidos_continua_conferindo (AF-07): a conta recém-cadastrada que já recebeu continua "fornecedor novo"', async () => {
  for (const value of ['', false, [], 0, -5]) {
    await rollback(async (t) => {
      await K.store(t, 'antifraude.fornecedor_novo_dias', value);
      const acc = await K.account(t);
      await K.settled(t, acc.id, ['15000.00', '15000.00'], { costCenterId });
      const at = await K.payable(t, '20000.00', { bankAccountId: acc.id, costCenterId });
      assert.deepEqual(await K.casesOf(t, at.id), ['NEW_SUPPLIER_HIGH_VALUE:MEDIUM'], `dias gravados ${JSON.stringify(value)}`);
      assert.match(at.manualReviewReason, /conta do favorecido cadastrada há 0 dia\(s\) \(menos de 30\)/);
    });
  }
});
