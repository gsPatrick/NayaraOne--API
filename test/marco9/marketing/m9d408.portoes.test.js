'use strict';

// M9-D408 — cada portão da autopublicação testado sozinho (condição 2) e a validação das classes do parâmetro marketing.autopublish.classes.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const env = require('../_helpers/mktAutopublish');
const { change } = require('../_helpers/m9d425Env');
const policy = require('../../../src/features/marketing/content/autopublish.policy');
const { parseClasses } = require('../../../src/features/marketing/content/autopublish.settings');

let ctx;
before(async () => { ctx = await env.setup(); });
after(async () => { await sequelize.close(); });
afterEach(env.reset);

const inTx = (fn) => env.withRollbackTenantTransaction(ctx.tenant, fn);

/** Item da NAY pronto (COMPLIANCE_CHECKED) que a política avalia: roda o pipeline até o passo anterior à aprovação. */
async function readyItem(t) {
  await env.setClasses(t, ctx.tenant, [env.SOLD_CLASS]);
  env.registerNay();
  const prop = await env.tipos.activeProperty(t, ctx.tenant);
  await env.tipos.setAvailability(t, prop.propertyId, 'SOLD');
  const tpl = await env.fx.publishedTemplate(t, ctx.tenant, { channel: 'SITE', body: 'Vendido em {{bairro}}: {{texto}}', variables: [{ name: 'bairro', type: 'text' }, { name: 'texto', type: 'text' }] });
  const { itemId } = await env.service.createContent({ tenant: ctx.tenant, actor: ctx.tenant.userId, input: { type: 'SOLD_RENTED', sourceEntityType: 'property', sourceEntityId: prop.propertyId, channels: ['SITE'], templateId: tpl.id } }, t);
  const run = (fn, extra = {}) => fn({ tenant: ctx.tenant, actor: ctx.tenant.userId, itemId, ...extra }, t);
  await run(env.service.runFactualCheck);
  await run(env.service.applyTemplate, { templateId: tpl.id });
  await run(env.service.applyCompliance);
  return { itemId, templateId: tpl.id };
}

/** `mutate` altera a versão EM MEMÓRIA (o banco proíbe mudar o corpo, o modelo e o template de uma versão gravada). */
const evaluate = async (t, itemId, mutate) => {
  const repo = env.service.repo;
  const item = await repo.lockItem(itemId, t);
  const version = await repo.findVersion(item.current_version_id, t);
  if (mutate) mutate(version);
  return policy.evaluateAutopublish({ item, version, tenant: ctx.tenant, transaction: t });
};
const setChecks = (t, itemId, patch) => env.fx.q(t, `UPDATE marketing.content_versions SET checks_json = checks_json || CAST(:p AS jsonb)
  WHERE id = (SELECT current_version_id FROM marketing.content_items WHERE id = :i)`, { i: itemId, p: JSON.stringify(patch) });

test('todos_os_portoes_verdes_autorizam', async () => {
  await inTx(async (t) => {
    const { itemId } = await readyItem(t);
    const out = await evaluate(t, itemId);
    assert.equal(out.autopublish, true, JSON.stringify(out));
    assert.equal(out.classId, 'SOLD_RENTED+SITE');
    assert.deepEqual(out.channels, ['SITE']);
  });
});

test('autopublicacao_exige_todos_os_portoes: cada portao reprovado sozinho recusa com o seu motivo', async () => {
  const inMemory = {
    NOT_NAY: (v) => { v.model_name = null; },
    TEMPLATE_VERSION_MISMATCH: (v) => { v.template_version_no = 99; },
    TEMPLATE_REQUIRED: (v) => { v.template_id = null; v.template_version_no = null; },
  };
  const inDatabase = {
    STATUS_NOT_COMPLIANCE_CHECKED: (t, itemId) => env.fx.q(t, "UPDATE marketing.content_items SET status = 'BRANDED' WHERE id = :i", { i: itemId }),
    FACTUAL_NOT_OK: (t, itemId) => setChecks(t, itemId, { factual: { ok: false, at: new Date().toISOString(), detalhes: { findings: [{ reason: 'MISMATCH' }] } } }),
    NOT_SANITIZED: (t, itemId) => setChecks(t, itemId, { compliance: { ok: false, at: new Date().toISOString(), detalhes: {} } }),
    INJECTION_SUSPECT: (t, itemId) => setChecks(t, itemId, { factual: { ok: true, at: new Date().toISOString(), detalhes: { findings: [{ reason: 'INJECTION' }] } } }),
    TEMPLATE_NOT_PUBLISHED: (t, itemId, tpl) => env.fx.q(t, "UPDATE marketing.templates SET status = 'RETIRED' WHERE id = :t", { t: tpl }),
    NO_CLASS: (t) => env.setClasses(t, ctx.tenant, []),
    KILL_SWITCH: (t) => change(t, ctx.tenant, { scope: 'CHANNEL', targetId: 'SITE', active: true }),
  };
  for (const [reason, mutate] of Object.entries(inMemory)) {
    await inTx(async (t) => {
      const { itemId } = await readyItem(t);
      const out = await evaluate(t, itemId, mutate);
      assert.equal(out.autopublish, false, `${reason} deveria recusar`);
      assert.deepEqual(out.reasons, [reason], `${reason} sozinho`);
    });
  }
  for (const [reason, breakIt] of Object.entries(inDatabase)) {
    await inTx(async (t) => {
      const { itemId, templateId } = await readyItem(t);
      await breakIt(t, itemId, templateId);
      const out = await evaluate(t, itemId);
      assert.equal(out.autopublish, false, `${reason} deveria recusar`);
      assert.ok(out.reasons.includes(reason), `${reason}: motivos ${JSON.stringify(out.reasons)}`);
    });
  }
});

test('parseClasses: formato, tipos, canais e duplicidade', () => {
  assert.deepEqual(parseClasses('[]'), []);
  assert.deepEqual(parseClasses(''), []);
  const ok = parseClasses(JSON.stringify([{ tipo: 'SOLD_RENTED', canal: 'SITE' }]));
  assert.deepEqual(ok, [{ id: 'SOLD_RENTED+SITE', tipo: 'SOLD_RENTED', canal: 'SITE', quando: 0, canais_agendamento: ['SITE'] }]);
  const bad = [
    'não é json', '{}', '[1]', JSON.stringify([{ tipo: 'XYZ', canal: 'SITE' }]), JSON.stringify([{ tipo: 'SOLD_RENTED', canal: 'WHATSAPP' }]),
    JSON.stringify([{ tipo: 'SOLD_RENTED', canal: 'SITE', quando: -1 }]), JSON.stringify([{ tipo: 'SOLD_RENTED', canal: 'SITE', canais_agendamento: [] }]),
    JSON.stringify([{ tipo: 'SOLD_RENTED', canal: 'SITE', canais_agendamento: ['WHATSAPP'] }]), JSON.stringify([{ tipo: 'SOLD_RENTED', canal: 'SITE', extra: 1 }]),
    JSON.stringify([{ tipo: 'SOLD_RENTED', canal: 'SITE' }, { tipo: 'SOLD_RENTED', canal: 'SITE' }]),
    JSON.stringify([{ tipo: 'INSTITUTIONAL', canal: 'PORTAL' }, { tipo: 'NEW_PROPERTY', canal: 'EMAIL' }]),
  ];
  for (const text of bad) assert.throws(() => parseClasses(text), (e) => e.statusCode === 422 && e.code === 'MKT_PARAM_INVALID', text);
});

test('a_escrita_do_parametro_valida_as_classes_pelo_dicionario_da_empresa', async () => {
  await inTx(async (t) => {
    await assert.rejects(env.setClasses(t, ctx.tenant, [{ tipo: 'XYZ', canal: 'SITE' }]), (e) => e.code === 'MKT_PARAM_INVALID' || e.statusCode === 422 || e.statusCode === 400);
    await env.setClasses(t, ctx.tenant, [env.SOLD_CLASS]);
    assert.deepEqual((await policy.readClasses(ctx.tenant, t)).map((c) => c.id), ['SOLD_RENTED+SITE']);
  });
});
