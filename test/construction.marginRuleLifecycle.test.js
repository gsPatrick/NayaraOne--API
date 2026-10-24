'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const marginRulesService = require('../src/features/construction/marginRules.service');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

test('margem mínima: publicar versões, alterar, desativar e reativar preservam o histórico e nunca apagam versão', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const ctx = { groupId: tenant.groupId, companyId: tenant.companyId };
    // Isola o teste de qualquer regra que a empresa já tenha: desativa a vigente, se houver.
    await marginRulesService.deactivateMarginRule(ctx.groupId, ctx.companyId, 'preparo do teste', tenant.userId, transaction).catch(() => null);
    const base = (await marginRulesService.listMarginRuleVersions(ctx.groupId, ctx.companyId, transaction)).length;

    const v1 = await marginRulesService.createMarginRule({ ...ctx, minMarginPct: 10, description: 'Configuração de homologação', enforcementMode: 'ALERT' }, tenant.userId, transaction);
    const v2 = await marginRulesService.createMarginRule({ ...ctx, minMarginPct: 12.5, description: 'Configuração de homologação', enforcementMode: 'BLOCK' }, tenant.userId, transaction);
    assert.notEqual(v1.id, v2.id);

    let versions = await marginRulesService.listMarginRuleVersions(ctx.groupId, ctx.companyId, transaction);
    assert.equal(versions.length, base + 2);
    assert.equal(versions[0].minMarginPct, 12.5);
    assert.equal(versions[0].isActive, true);
    assert.equal(versions[1].minMarginPct, 10);
    assert.equal(versions[1].isActive, false);
    assert.ok(versions[1].effectiveUntil, 'a versão anterior tem a vigência fechada, não apagada');
    assert.equal(versions[0].description, 'Configuração de homologação');

    const active = await marginRulesService.getActiveMarginRule(ctx.groupId, ctx.companyId, transaction);
    assert.equal(active.minMarginPct, 12.5);
    assert.equal(active.enforcementMode, 'BLOCK');

    await marginRulesService.deactivateMarginRule(ctx.groupId, ctx.companyId, 'fim da homologação', tenant.userId, transaction);
    await assert.rejects(
      () => marginRulesService.getActiveMarginRule(ctx.groupId, ctx.companyId, transaction),
      (err) => err.code === 'MARGIN_RULE_NOT_CONFIGURED'
    );
    versions = await marginRulesService.listMarginRuleVersions(ctx.groupId, ctx.companyId, transaction);
    assert.equal(versions.length, base + 2, 'desativar não apaga nenhuma versão');
    assert.equal(versions.filter((v) => v.isActive).length, 0);

    await assert.rejects(
      () => marginRulesService.deactivateMarginRule(ctx.groupId, ctx.companyId, 'de novo', tenant.userId, transaction),
      (err) => err.code === 'MARGIN_RULE_NOT_CONFIGURED'
    );

    const v3 = await marginRulesService.createMarginRule({ ...ctx, minMarginPct: 10, enforcementMode: 'ALERT' }, tenant.userId, transaction);
    assert.equal((await marginRulesService.getActiveMarginRule(ctx.groupId, ctx.companyId, transaction)).id, v3.id);
  });
});
