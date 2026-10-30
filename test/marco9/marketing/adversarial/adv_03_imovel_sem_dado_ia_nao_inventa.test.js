'use strict';

// M9-D436 adv_03 (Caderno §16: "Imóvel sem dado -> IA não inventa"). Imóvel sem área e sem vagas; a NAY sandbox devolve um texto com "120 m²" e "2 vagas". O validador factual reprova
// por dado inexistente (reason MISSING) e nada avança no pipeline. Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const { withRollbackTenantTransaction } = require('../../../testHelpers');
const { prepararTenants } = require('../../../helpers/marketingExecucao');
const fx = require('../../../helpers/m9d406Fixtures');
const nay = require('../../../../src/features/marketing/content/pipeline.nayPort');
const factual = require('../../../../src/features/marketing/content/pipeline.factualPort');
const service = require('../../../../src/features/marketing/content/content.service');

let tenant;
before(async () => { ({ tenantA: tenant } = await prepararTenants()); });
after(async () => { await sequelize.close(); });
afterEach(() => { nay.clearNayDraftProvider(); factual.resetFactualValidator(); });

test('adv_03_imovel_sem_dado_ia_nao_inventa', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await fx.seedProperty(t, tenant);
    await fx.q(t, 'UPDATE real_estate.properties SET area_total_m2 = NULL, parking_spots = NULL WHERE id = :id RETURNING id', { id: prop.id });
    const tpl = await fx.publishedTemplate(t, tenant);
    fx.registerSandboxNay(() => 'Casa de 120 m² com 2 vagas de garagem, em ótima localização.');

    const out = await service.createAndRun({ tenant, actor: tenant.userId, input: { type: 'NEW_PROPERTY', sourceEntityType: 'property', sourceEntityId: prop.id, templateId: tpl.id } }, fx.sameTx(t));
    assert.equal(out.content.status, 'FACT_CHECK_FAILED');
    const missing = (out.content.findings || []).filter((f) => f.reason === 'MISSING');
    assert.ok(missing.some((f) => f.kind === 'AREA'), 'a área citada não existe no cadastro');
    assert.ok(missing.some((f) => f.kind === 'ROOMS' || /vaga/i.test(f.claim) || /vaga/i.test(f.message)), 'as vagas citadas não existem no cadastro');
    assert.ok(missing.every((f) => f.severity === 'BLOCK'));
    assert.match(missing[0].message, /dado inexistente/);
    // (1) nada avança: o conteúdo ficou em FACT_CHECK_FAILED, sem marca, conformidade nem aprovação, e não há job
    const [item] = await fx.q(t, "SELECT id, status FROM marketing.content_items WHERE source_entity_id = :p ORDER BY created_at DESC LIMIT 1", { p: prop.id });
    assert.equal(item.status, 'FACT_CHECK_FAILED');
    const [version] = await fx.q(t, 'SELECT checks_json FROM marketing.content_versions WHERE content_item_id = :i ORDER BY version_no DESC LIMIT 1', { i: item.id });
    assert.equal(version.checks_json.factual.ok, false, 'o motivo fica gravado no checks_json');
    assert.ok(!version.checks_json.branding && !version.checks_json.compliance && !version.checks_json.approval, 'nenhum passo seguinte rodou');
    assert.equal((await fx.q(t, 'SELECT count(*)::int AS n FROM marketing.publication_jobs WHERE content_version_id IN (SELECT id FROM marketing.content_versions WHERE content_item_id = :i)', { i: item.id }))[0].n, 0);
    // (2) pelo menos 1 finding de dado inexistente e zero avanços de status
    assert.ok(version.checks_json.factual.detalhes.findings.filter((f) => f.reason === 'MISSING').length >= 1);
    // isolamento (RLS): a outra empresa não enxerga o que este cenário gravou
    await require('../../_helpers/mktAdv').assertIsolated(t, tenant, [{ tabela: 'marketing.content_items', ids: [item.id] }]);
  });
});
