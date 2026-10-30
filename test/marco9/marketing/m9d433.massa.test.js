'use strict';

// M9-D433 — mass messaging (permissão e dois tetos, ao agendar e a cada step) e nenhuma exportação de destinatários. Postgres real (RLS), transação com rollback.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const campaigns = require('../../../src/features/marketing/campaigns/campaigns.service');
const { assertMassSendAllowed, MASS_PERMISSION } = require('../../../src/features/marketing/marketing.guards');
const { massStepReason } = require('../../../src/features/marketing/campaigns/massStep.guard');
const security = require('../../../src/features/marketing/security');
const { tenants, makePerson, makeTemplate, completeBody, loadCampaign, q, rejectsWith } = require('../../helpers/m9d412Fixtures');

let A;
before(async () => { ({ a: A } = await tenants()); });
after(async () => { await sequelize.close(); });
const MANAGER = ['marketing:campaign:manage'];
const WITH_MASS = [...MANAGER, MASS_PERMISSION];
const guard = (t, recipients, permissions = []) => assertMassSendAllowed({ recipients, permissions, tenant: A, transaction: t });
const save = (t, body, permissions = MANAGER) => campaigns.saveCampaign(A, A.userId, body, { permissions }, t);

test('mass_messaging_exige_permissao_e_limite', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    assert.equal((await guard(t, 50)).massConfirmed, false, 'até o limite sem aprovação não precisa de permissão');
    await rejectsWith(assert, guard(t, 80), 403, 'MKT_MASS_PERMISSION_REQUIRED');
    assert.equal((await guard(t, 80, [MASS_PERMISSION])).massConfirmed, true, 'a permissão é a confirmação explícita: não há segunda tela');
    await rejectsWith(assert, guard(t, 6000, [MASS_PERMISSION]), 422, 'MKT_MASS_LIMIT_EXCEEDED');
  });
});

test('massa_acima_do_teto_absoluto_e_recusada_e_entre_50_e_5000_exige_permissao', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const casos = [[0, null, false], [50, null, false], [51, 403, true], [5000, null, true], [5001, 422, true]];
    for (const [n, status, precisaPermissao] of casos) {
      if (status === null && !precisaPermissao) { assert.equal((await guard(t, n)).recipients, n, `${n} sem permissão`); continue; }
      if (precisaPermissao && status !== 422) await rejectsWith(assert, guard(t, n), 403, 'MKT_MASS_PERMISSION_REQUIRED');
      if (status === null) assert.equal((await guard(t, n, [MASS_PERMISSION])).recipients, n, `${n} com permissão`);
      else if (status === 422) {
        await rejectsWith(assert, guard(t, n, [MASS_PERMISSION]), 422, 'MKT_MASS_LIMIT_EXCEEDED');
        await rejectsWith(assert, guard(t, n), 422, 'MKT_MASS_LIMIT_EXCEEDED'); // o teto absoluto vale primeiro, com ou sem permissão
      }
    }
    await rejectsWith(assert, guard(t, -1, [MASS_PERMISSION]), 422, 'MKT_MASS_LIMIT_EXCEEDED');
    await rejectsWith(assert, guard(t, 'muitos', [MASS_PERMISSION]), 422, 'MKT_MASS_LIMIT_EXCEEDED');
    // os dois tetos são parâmetros da empresa: mudar o valor muda o resultado
    await upsertSetting('marketing.mass.max_recipients_sem_aprovacao', 10, A, A.userId, t);
    await upsertSetting('marketing.mass.max_recipients_absoluto', 20, A, A.userId, t);
    await rejectsWith(assert, guard(t, 11), 403, 'MKT_MASS_PERMISSION_REQUIRED');
    await rejectsWith(assert, guard(t, 21, [MASS_PERMISSION]), 422, 'MKT_MASS_LIMIT_EXCEEDED');
  });
});

test('o_teto_de_massa_vale_a_cada_step_pelo_publico_congelado_e_pela_confirmacao_gravada', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    await upsertSetting('marketing.mass.max_recipients_sem_aprovacao', 2, A, A.userId, t);
    await upsertSetting('marketing.mass.max_recipients_absoluto', 4, A, A.userId, t);
    const templateId = await makeTemplate(t, A);
    const people = [];
    for (let i = 0; i < 4; i += 1) people.push(await makePerson(t, A));
    const body = (n) => completeBody({ templateId, personIds: people.slice(0, n), schedule: true });

    const dentro = (await save(t, body(2))).campaign;
    assert.equal(await massStepReason(await loadCampaign(t, dentro.id), A, t), null, 'dentro do limite sem aprovação: o step segue');
    assert.equal((await loadCampaign(t, dentro.id)).mass_confirmed_by, null, 'sem massa, nenhuma confirmação é gravada');

    const massa = (await save(t, body(3), WITH_MASS)).campaign;
    const row = await loadCampaign(t, massa.id);
    assert.equal(row.mass_confirmed_by, A.userId, 'a permissão de quem agendou fica gravada como a confirmação');
    assert.ok(row.mass_confirmed_at);
    assert.equal(await massStepReason(row, A, t), null, 'com a confirmação gravada, o step de 3 destinatários segue');

    await upsertSetting('marketing.mass.max_recipients_absoluto', 2, A, A.userId, t); // o administrador baixou o teto depois do agendamento
    assert.equal(await massStepReason(row, A, t), 'MKT_MASS_LIMIT_EXCEEDED', 'o step é recusado: o tamanho congelado passa do teto vigente');

    await upsertSetting('marketing.mass.max_recipients_absoluto', 4, A, A.userId, t);
    await q(t, 'UPDATE marketing.campaigns SET mass_confirmed_by = NULL, mass_confirmed_at = NULL WHERE id = :id RETURNING id', { id: massa.id });
    assert.equal(await massStepReason(await loadCampaign(t, massa.id), A, t), 'MKT_MASS_PERMISSION_REQUIRED', 'sem a confirmação gravada, acima do limite sem aprovação o step não sai');
  });
});

test('nao_existe_exportacao_de_destinatarios', async () => {
  const marketing = require('../../../src/features/marketing');
  const paths = [];
  const walk = (router, base) => router.stack.forEach((layer) => {
    if (layer.route) paths.push(`${base}${layer.route.path}`);
    else if (layer.handle && layer.handle.stack) walk(layer.handle, base);
  });
  for (const area of Object.values(marketing.areas)) walk(area.router, '');
  walk(marketing.router, '');
  assert.ok(paths.length > 20, 'a varredura percorreu as rotas do Marketing');
  assert.deepEqual(paths.filter((p) => security.looksLikeExport({ path: p, query: {} })), [], 'nenhuma rota é de exportação');
  // o pedido que parece exportação é recusado antes de qualquer rota
  const recusa = (req) => { let err = null; security.recipientExportGuard(req, {}, (e) => { err = e; }); return err; };
  for (const req of [{ path: '/marketing/campaigns/1/export', query: {} }, { path: '/marketing/campaigns/1/audience.csv', query: {} }, { path: '/marketing/campaigns/1', query: { format: 'xlsx' } }, { path: '/marketing/campaigns/1/download', query: {} }]) {
    const err = recusa(req);
    assert.ok(err && err.statusCode === 403 && err.code === 'MKT_EXPORT_FORBIDDEN' && /não é permitido/.test(err.message), JSON.stringify(req));
  }
  assert.equal(recusa({ path: '/marketing/campaigns/1', query: {} }), undefined);
  assert.equal(recusa({ path: '/marketing/campaigns', query: { page: '2' } }), undefined);
  // a consulta mostra só a contagem (nenhum id de pessoa na resposta)
  await withRollbackTenantTransaction(A, async (t) => {
    const templateId = await makeTemplate(t, A);
    const { campaign } = await save(t, completeBody({ templateId, personIds: [await makePerson(t, A)], schedule: true }));
    const got = await campaigns.getCampaign(A, campaign.id, t);
    assert.equal(JSON.stringify(got).includes('personIds'), false);
    assert.equal(got.audiences[0].filter.personCount, 1);
  });
});
