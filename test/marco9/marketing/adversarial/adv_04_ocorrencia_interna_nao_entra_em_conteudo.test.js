'use strict';

// M9-D436 adv_04 (Caderno §16: "Ocorrência interna -> não entra em conteúdo"). Imóvel com ocorrência interna "infiltração no teto": o que a NAY recebe, o texto, os fatos gravados e o
// payload entregue ao canal não a trazem, e a chave removida fica registrada (M9-D403); se o texto de saída a citar, a varredura de saída reprova (M9-D433). Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const { withRollbackTenantTransaction } = require('../../../testHelpers');
const { prepararTenants } = require('../../../helpers/marketingExecucao');
const fx = require('../../../helpers/m9d406Fixtures');
const nay = require('../../../../src/features/marketing/content/pipeline.nayPort');
const service = require('../../../../src/features/marketing/content/content.service');
const { deliverToAdapter, recordSanitizationChecks } = require('../../../../src/features/marketing/content/adapterGate');

let tenant;
before(async () => { ({ tenantA: tenant } = await prepararTenants()); });
after(async () => { await sequelize.close(); });
afterEach(() => nay.clearNayDraftProvider());

const OCORRENCIA = 'infiltração no teto';
const comOcorrencia = async (t) => {
  const prop = await fx.seedProperty(t, tenant);
  await fx.q(t, `INSERT INTO real_estate.property_internal_occurrences (id, group_id, company_id, property_id, occurrence_type, description, visibility, created_by)
    VALUES (gen_random_uuid(), :g, :c, :p, 'RISK', :d, 'INTERNAL', :u)`, { g: tenant.groupId, c: tenant.companyId, p: prop.id, d: OCORRENCIA, u: tenant.userId });
  return prop;
};

test('adv_04_ocorrencia_interna_nao_entra_em_conteudo: payload da NAY, texto, fatos e entrega ao canal', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await comOcorrencia(t);
    const tpl = await fx.publishedTemplate(t, tenant);
    const calls = fx.registerSandboxNay();
    const out = await service.createAndRun({ tenant, actor: tenant.userId, input: { type: 'NEW_PROPERTY', sourceEntityType: 'property', sourceEntityId: prop.id, templateId: tpl.id } }, fx.sameTx(t));
    // (1) a ocorrência não saiu do cadastro: nem no que a NAY recebeu, nem no texto, nem nos fatos gravados
    assert.equal(calls.length, 1);
    assert.equal(JSON.stringify(calls[0]).toLowerCase().includes('infiltra'), false, 'o payload da NAY não tem a ocorrência');
    const [version] = await fx.q(t, 'SELECT body_json, facts_snapshot_json, id FROM marketing.content_versions WHERE content_item_id = :i ORDER BY version_no DESC LIMIT 1', { i: out.content.id });
    assert.equal(JSON.stringify(version.body_json).toLowerCase().includes('infiltra'), false, 'o texto não tem a ocorrência');
    assert.equal(JSON.stringify(version.facts_snapshot_json).toLowerCase().includes('infiltra'), false, 'os fatos gravados não têm a ocorrência');
    // (2) a chave removida é registrada: o adapter recebe o payload sanitizado e o checks_json guarda removedKeys
    let recebido = null;
    const adapter = { publish: async (p) => { recebido = p; return { ok: true }; } };
    const dirty = { ...version.facts_snapshot_json, texto: 'Casa nova.', ocorrenciaInterna: OCORRENCIA };
    const delivered = await deliverToAdapter(adapter, 'publish', dirty, { policy: 'SO_BAIRRO', tenant, transaction: t });
    assert.equal('ocorrenciaInterna' in recebido, false, 'o canal não recebe a chave');
    assert.ok(delivered.removedKeys.includes('ocorrenciaInterna'));
    await recordSanitizationChecks(version.id, { removedKeys: delivered.removedKeys, redactedPatterns: delivered.redactedPatterns, policy: 'SO_BAIRRO' }, tenant, t);
    const [saved] = await fx.q(t, 'SELECT checks_json FROM marketing.content_versions WHERE id = :v', { v: version.id });
    assert.ok(saved.checks_json.sanitization.removedKeys.includes('ocorrenciaInterna'), 'a chave removida fica no checks_json da versão');
    // isolamento (RLS): a outra empresa não enxerga o que este cenário gravou
    await require('../../_helpers/mktAdv').assertIsolated(t, tenant, [{ tabela: 'marketing.content_versions', ids: [version.id] }]);
  });
});

test('adv_04_ocorrencia_interna_nao_entra_em_conteudo: texto de saída que cita a ocorrência é reprovado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await comOcorrencia(t);
    const tpl = await fx.publishedTemplate(t, tenant);
    fx.registerSandboxNay(() => `Casa de 3 quartos. Há ocorrência interna de ${OCORRENCIA}.`);
    const out = await service.createAndRun({ tenant, actor: tenant.userId, input: { type: 'NEW_PROPERTY', sourceEntityType: 'property', sourceEntityId: prop.id, templateId: tpl.id } }, fx.sameTx(t));
    assert.equal(out.content.status, 'FACT_CHECK_FAILED');
    assert.ok(out.content.findings.some((f) => f.kind === 'INTERNAL_REFERENCE' && f.reason === 'INTERNAL_REFERENCE'), 'o motivo fica registrado');
    const [item] = await fx.q(t, "SELECT status FROM marketing.content_items WHERE source_entity_id = :p ORDER BY created_at DESC LIMIT 1", { p: prop.id });
    assert.equal(item.status, 'FACT_CHECK_FAILED', 'o conteúdo não avança');
  });
});
