'use strict';

// DEC-007, rodada 2 (verificação dec007-mfa.md: AF-02, AF-03, AF-04 e DI-01 (d)). A DEC-007 manda "trocar a regra do Motor pelos parâmetros da tela de
// Configurações": o valor gravado pela tela vale sempre, mais restritivo ou mais frouxo, dentro da faixa do catálogo, com ou sem uma regra FIN-005
// publicada no Motor (DI-DEC007-2). Empresa nova funciona sem script (padrões da DEC-007). A migration 20260101009988 leva o valor mais restritivo de uma
// FIN-005 publicada para os parâmetros e aposenta a regra, com auditoria; a 20260101009989 realinha os casos abertos na escala de risco anterior.
// Serviço real, empresa isolada do banco descartável, cada caso numa transação desfeita.

const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const T = require('./testHelpers');
const { isolatedTenant, closeIsolated } = require('./helpers/m4FinanceHttp');
const { gravarParametro } = require('./helpers/mfaRecente');
const { kit } = require('./helpers/antifraudeDec007');
const antifraud = require('../src/modules/finance/application/services/finance-antifraud.service');
const bankAccountsService = require('../src/modules/finance/application/services/bank-accounts.service');
const fin005 = require('../src/modules/finance/infrastructure/db/migrations/20260101009988-dec007-fin005-para-parametros');
const niveis = require('../src/modules/finance/infrastructure/db/migrations/20260101009989-dec007-niveis-de-risco-dos-casos-abertos');
const { FINANCE_SETTINGS_SCHEMA, FINANCE_SETTINGS_DEFAULTS } = require('../src/modules/finance/application/services/finance-settings');
const { AnomalyCase, Rule, RuleVersion, RuleScope, RulePublication, TenantSetting } = require('../src/models');

let tenant;
let costCenterId;
const K = kit(() => tenant);
const rollback = (fn) => T.withRollbackTenantTransaction(tenant, fn);
const q = (t) => (sql, replacements) => T.sequelize.query(sql, { replacements, transaction: t });

before(async () => {
  tenant = await isolatedTenant('dec007b-tela');
  await T.withTenantTransaction(tenant, async (t) => { costCenterId = (await T.createTestCostCenter(tenant, t)).id; });
});

after(async () => {
  await closeIsolated();
  await T.sequelize.close();
});

/** Publica à mão uma versão da regra FIN-005 no Motor (como fazia o script removido), com o `action_json` informado. */
async function publishFin005(t, actionJson) {
  const ctx = { groupId: tenant.groupId, companyId: tenant.companyId, createdBy: tenant.userId, updatedBy: tenant.userId };
  const rule = await Rule.create({ ...ctx, code: 'FIN-005', name: 'Antifraude de pagamento ativo', description: 'teste', domain: 'finance' }, { transaction: t });
  const condition = { fact: 'financeAntifraudRuleActive', op: '==', value: true };
  const version = await RuleVersion.create({ ...ctx, ruleId: rule.id, versionNumber: 1, conditionAstJson: condition, contentHash: crypto.createHash('sha256').update(JSON.stringify(condition)).digest('hex'), actionJson, effectiveFrom: new Date(Date.now() - 60000), effectiveUntil: null, status: 'PUBLISHED', publishedByUserId: tenant.userId }, { transaction: t });
  await RuleScope.create({ ...ctx, ruleVersionId: version.id, scopeType: 'GLOBAL', scopeRefId: null, precedence: 7 }, { transaction: t });
  await RulePublication.create({ ...ctx, ruleVersionId: version.id, publishedByUserId: tenant.userId, publishedAt: new Date() }, { transaction: t });
  return version;
}

test('dec007b_empresa_nova_sem_script_usa_os_padroes_da_DEC_007: nada gravado e nenhuma regra publicada', async () => {
  await rollback(async (t) => {
    const th = await antifraud.resolveAntifraudThresholds(tenant, t);
    assert.deepEqual([th.historyMultiplier, th.newAccountThreshold, th.cooldownHours, th.outlierBlockMultiplier, th.outlierMinSample, th.outlierHistoryMonths], [3, 5000, 48, 10, 5, 12]);
  });
});

test('dec007b_valor_da_tela_vale_mais_frouxo_ou_mais_restritivo (AF-02, AF-03, AF-04), com ou sem FIN-005 publicada', async () => {
  for (const withRule of [false, true]) {
    await rollback(async (t) => {
      if (withRule) await publishFin005(t, { historyMultiplier: 2, newAccountThreshold: 1000, bankAccountCooldownHours: 96 });
      await gravarParametro('finance.bank_account_cooldown_hours', 12, tenant, t);
      await gravarParametro('finance.antifraud_new_account_threshold', 8000, tenant, t);
      await gravarParametro('finance.antifraud_history_multiplier', 5, tenant, t);
      const th = await antifraud.resolveAntifraudThresholds(tenant, t);
      assert.deepEqual([th.cooldownHours, th.newAccountThreshold, th.historyMultiplier], [12, 8000, 5], `regra publicada: ${withRule}`);
      // AF-03: primeiro pagamento de 6.000 a conta sem histórico não é retido com o limite em 8.000.
      assert.equal((await K.payable(t, '6000.00', { bankAccountId: (await K.account(t)).id, costCenterId })).requiresManualReview, false);
      // AF-04: 4x a mediana não é retido com o múltiplo de revisão em 5.
      const acc = await K.account(t);
      await K.settled(t, acc.id, ['1000.00', '1000.00', '1000.00', '1000.00', '1000.00'], { costCenterId });
      assert.equal((await K.payable(t, '4000.00', { bankAccountId: acc.id, costCenterId })).requiresManualReview, false);
      // AF-02: conta em resfriamento há 20 h já recebe com a espera em 12 h.
      const cooling = await bankAccountsService.createBankAccount({ ...K.base(), bankCode: '341', agency: '0001', accountNumber: `${T.uniqueSuffix()}` }, tenant.userId, t);
      await T.sequelize.query("UPDATE finance.bank_accounts SET updated_at = now() - interval '20 hours' WHERE id = :id", { replacements: { id: cooling.id }, transaction: t });
      assert.equal((await antifraud.assertBankAccountEligibleForPayment(cooling.id, t)).status, 'ACTIVE');
    });
  }
  await rollback(async (t) => {
    await gravarParametro('finance.bank_account_cooldown_hours', 72, tenant, t);
    const cooling = await bankAccountsService.createBankAccount({ ...K.base(), bankCode: '341', agency: '0001', accountNumber: `${T.uniqueSuffix()}` }, tenant.userId, t);
    await T.sequelize.query("UPDATE finance.bank_accounts SET updated_at = now() - interval '50 hours' WHERE id = :id", { replacements: { id: cooling.id }, transaction: t });
    await assert.rejects(antifraud.assertBankAccountEligibleForPayment(cooling.id, t), (err) => err.code === 'FINANCE_BANK_ACCOUNT_COOLDOWN', 'mais restritivo também vale: 50 h < 72 h');
  });
});

test('dec007b_migration_fin005_leva_o_valor_mais_restritivo_para_os_parametros_e_aposenta_a_regra_com_auditoria', async () => {
  for (const m of fin005.MAPA) {
    assert.equal(FINANCE_SETTINGS_DEFAULTS[m.key], m.padrao, `${m.key}: padrão da migration acompanha o código`);
    assert.deepEqual([FINANCE_SETTINGS_SCHEMA[m.key].min, FINANCE_SETTINGS_SCHEMA[m.key].max], [m.min, m.max], `${m.key}: faixa`);
  }
  await rollback(async (t) => {
    const version = await publishFin005(t, { historyMultiplier: 2, newAccountThreshold: 10000, bankAccountCooldownHours: 96 });
    await K.store(t, 'finance.bank_account_cooldown_hours', 24); // já gravado na tela: valia o gravado, continua
    const auditBefore = Number((await q(t)("SELECT count(*) AS n FROM audit.audit_log WHERE action IN ('finance.antifraud.fin005_value_migrated', 'rules.version_retired') AND company_id = :c", { c: tenant.companyId }))[0][0].n);
    const out = await fin005.migrar(q(t));
    assert.ok(out.aposentadas >= 1);
    assert.deepEqual(out.levados.filter((l) => l.companyId === tenant.companyId), [{ companyId: tenant.companyId, key: 'finance.antifraud_history_multiplier', value: 2 }]);
    const stored = Object.fromEntries((await TenantSetting.findAll({ where: { companyId: tenant.companyId }, transaction: t })).map((r) => [r.key, r.value]));
    assert.equal(stored['finance.antifraud_history_multiplier'], 2, 'o 2 da regra (mais restritivo que 3) passa a ser o parâmetro');
    assert.equal(stored['finance.bank_account_cooldown_hours'], 24, 'o valor gravado na tela não muda');
    assert.equal(stored['finance.antifraud_new_account_threshold'], undefined, '10.000 (mais frouxo que 5.000) não valia e não é levado');
    assert.equal((await RuleVersion.findByPk(version.id, { transaction: t })).status, 'RETIRED');
    const auditAfter = Number((await q(t)("SELECT count(*) AS n FROM audit.audit_log WHERE action IN ('finance.antifraud.fin005_value_migrated', 'rules.version_retired') AND company_id = :c", { c: tenant.companyId }))[0][0].n);
    assert.equal(auditAfter - auditBefore, 2, 'um valor levado e uma versão aposentada, cada um com a sua linha de auditoria');
    const th = await antifraud.resolveAntifraudThresholds(tenant, t);
    assert.deepEqual([th.historyMultiplier, th.cooldownHours, th.newAccountThreshold], [2, 24, 5000], 'o efetivo depois da migration é o que valia antes');
    assert.equal((await fin005.migrar(q(t))).levados.filter((l) => l.companyId === tenant.companyId).length, 0, 'idempotente');
  });
});

test('dec007b_migration_realinha_os_casos_abertos_na_escala_de_risco_anterior_com_auditoria', async () => {
  await rollback(async (t) => {
    const mk = (caseType, riskLevel, reason, status = 'OPEN') => AnomalyCase.create({ ...K.base(), caseType, riskLevel, reason, status, relatedEntityType: 'FinancialEntry', relatedEntityId: crypto.randomUUID() }, { transaction: t });
    const review = await mk('AMOUNT_OUTLIER', 'HIGH', 'Valor 3000.00 é 3.0x a média histórica (1000.00) dos 2 pagamentos (limiar FIN-005: 3x revisa, 10x bloqueia).');
    const first = await mk('AMOUNT_OUTLIER', 'HIGH', 'Primeiro pagamento desta conta bancária já no valor de 9000.00 (limite FIN-005 para conta sem histórico: 5000.00).');
    const block = await mk('AMOUNT_OUTLIER', 'CRITICAL', 'Valor 10000.00 é 10.0x a média histórica. O pagamento fica bloqueado até a revisão.');
    const reversal = await mk('FREQUENT_REVERSAL', 'HIGH', 'Estorno frequente: 3 estornos na empresa.');
    const closed = await mk('AMOUNT_OUTLIER', 'CRITICAL', 'histórico', 'RESOLVED');
    const fresh = await mk('AMOUNT_OUTLIER', 'HIGH', 'Valor 25000.00 é 12.5x a mediana (2000.00). O pagamento fica bloqueado até a revisão.');
    await niveis.realinharCasos(q(t));
    const now = async (c) => { const r = await AnomalyCase.findByPk(c.id, { transaction: t }); return `${r.caseType}:${r.riskLevel}`; };
    assert.deepEqual(
      [await now(review), await now(first), await now(block), await now(reversal), await now(closed), await now(fresh)],
      ['AMOUNT_OUTLIER:MEDIUM', 'NEW_ACCOUNT_IMMEDIATE_PAYMENT:MEDIUM', 'AMOUNT_OUTLIER:HIGH', 'FREQUENT_REVERSAL:MEDIUM', 'AMOUNT_OUTLIER:CRITICAL', 'AMOUNT_OUTLIER:HIGH']
    );
    const [[{ n }]] = await q(t)("SELECT count(*)::int AS n FROM audit.audit_log WHERE action = 'finance.anomaly_case.risk_realigned' AND entity_id IN (:ids)", { ids: [review.id, first.id, block.id, reversal.id] });
    assert.equal(n, 4, 'cada caso realinhado com o antes e o depois na auditoria');
    assert.equal((await niveis.realinharCasos(q(t))).realinhados, 0, 'idempotente');
  });
});
