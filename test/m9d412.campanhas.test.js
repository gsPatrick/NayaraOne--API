'use strict';

// M9-D412 — Campanhas (MKT-009): cadastro, itens obrigatórios, público, teto de massa e edição. Postgres real com a role de runtime
// (RLS FORCE), em transação com rollback. Rodar SOMENTE em banco descartável (o .env aponta para a homologação):
//   node scripts/withDisposableDb.js --port <porta> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/m9d412.campanhas.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../src/models');
const { withRollbackTenantTransaction } = require('./testHelpers');
const { upsertSetting } = require('../src/features/settings/settings.service');
const campaigns = require('../src/modules/marketing/campaigns/campaigns.service');
const {
  tenants, asTenant, makePerson, makeOpportunity, makeRadar, makeTemplate, completeBody, loadCampaign, loadSteps, q, uid, rejectsWith,
} = require('./helpers/m9d412Fixtures');

let A; let B;
const MANAGER = ['marketing:campaign:manage'];
const WITH_MASS = ['marketing:campaign:manage', 'marketing:send:mass'];
const save = (t, body, permissions = MANAGER) => campaigns.saveCampaign(A, A.userId, body, { permissions }, t);
const incomplete = (promise, items) => assert.rejects(promise, (e) => {
  assert.equal(e.statusCode, 422);
  assert.equal(e.code, 'MKT_CAMPAIGN_INCOMPLETE');
  for (const item of items) assert.ok(e.details.items.includes(item), `faltou o item ${item} em ${e.details.items}`);
  assert.match(e.message, /Faltam itens obrigatórios/);
  return true;
});

before(async () => { ({ a: A, b: B } = await tenants()); });
after(async () => { await sequelize.close(); });

test('campanha_exige_objetivo_publico_custo_e_meta', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const templateId = await makeTemplate(t, A);
    const personIds = [await makePerson(t, A)];
    const ok = completeBody({ templateId, personIds });

    // falta cada item obrigatório: 422 listando o item, e nada fica gravado
    const faltas = {
      objectiveMetric: { objectiveMetric: undefined }, targetValue: { targetValue: undefined }, budgetAmount: { budgetAmount: undefined },
      audiences: { audiences: [] }, steps: { steps: [] }, startsAt: { startsAt: undefined }, endsAt: { endsAt: undefined },
    };
    for (const [item, over] of Object.entries(faltas)) {
      const code = `QA-M9-${uid().slice(0, 8)}`;
      await incomplete(save(t, { ...ok, ...over, code, schedule: true }), [item]);
      const rows = await q(t, 'SELECT id FROM marketing.campaigns WHERE code = :code', { code });
      assert.equal(rows.length, 0, `${item}: a tentativa recusada não grava rascunho`);
    }
    // meta zero, orçamento zero sem justificativa e início no passado também são itens faltando
    await incomplete(save(t, { ...ok, targetValue: 0, schedule: true }), ['targetValue']);
    await incomplete(save(t, { ...ok, budgetAmount: 0, schedule: true }), ['budgetJustification']);
    await incomplete(save(t, { ...ok, startsAt: new Date(Date.now() - 3600e3).toISOString(), schedule: true }), ['startsAt']);
    await incomplete(save(t, { ...ok, endsAt: ok.startsAt, schedule: true }), ['endsAt']);

    // o objetivo (>= 10 caracteres) nunca é item de INCOMPLETE: sempre 400, até no rascunho
    for (const objective of ['curto', '', undefined]) {
      await rejectsWith(assert, save(t, { ...ok, objective, schedule: true }), 400, 'MKT_CAMPAIGN_VALIDATION');
      await rejectsWith(assert, save(t, { ...ok, objective }), 400, 'MKT_CAMPAIGN_VALIDATION');
    }

    // orçamento zero COM justificativa é aceito
    const zero = await save(t, { ...ok, budgetAmount: 0, budgetJustification: 'Ação orgânica, sem verba de mídia', schedule: true });
    assert.equal(zero.created, true);
    assert.equal(zero.campaign.status, 'SCHEDULED');

    // completa: SCHEDULED com tamanho congelado e lista materializada
    const done = await save(t, { ...ok, code: `QA-M9-${uid().slice(0, 8)}`, schedule: true });
    assert.equal(done.campaign.status, 'SCHEDULED');
    assert.equal(done.campaign.audiences[0].sizeFrozen, 1);
    assert.equal(done.campaign.audienceSize, 1);
    const members = await q(t, 'SELECT person_id FROM marketing.campaign_audience_members WHERE campaign_id = :id', { id: done.campaign.id });
    assert.deepEqual(members.map((m) => m.person_id), personIds);
  });
});

test('cross_company_audience_bloqueado', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const templateId = await makeTemplate(t, A);
    const mine = await makePerson(t, A);
    const foreign = await asTenant(t, A, B, () => makePerson(t, B, { name: 'QA-M9 Pessoa da outra empresa' }));
    const code = `QA-M9-${uid().slice(0, 8)}`;
    await rejectsWith(assert, save(t, completeBody({ templateId, personIds: [mine, foreign], code, schedule: true })), 422, 'MKT_AUDIENCE_CROSS_COMPANY');
    await rejectsWith(assert, save(t, completeBody({ templateId, personIds: [mine, foreign], code })), 422, 'MKT_AUDIENCE_CROSS_COMPANY');
    await rejectsWith(assert, save(t, completeBody({ templateId, personIds: [uid()], code, schedule: true })), 422, 'MKT_AUDIENCE_CROSS_COMPANY');
    assert.equal((await q(t, 'SELECT id FROM marketing.campaigns WHERE code = :code', { code })).length, 0, 'nenhuma campanha gravada');
    assert.equal((await q(t, 'SELECT id FROM marketing.campaign_audiences WHERE purpose = :p', { p: 'LANCAMENTO' })).length, 0, 'nenhuma audiência gravada');
    // o filtro de segmento também não aceita outra empresa
    const seg = { kind: 'SEGMENT', purpose: 'X', filter: { companyId: B.companyId, roles: ['CLIENTE'] } };
    await rejectsWith(assert, save(t, completeBody({ templateId, personIds: [mine], audiences: [seg], schedule: true })), 422, 'MKT_AUDIENCE_CROSS_COMPANY');
  });
});

test('transicao_invalida_recusa', async () => {
  const { assertTransition } = require('../src/modules/marketing/campaigns/campaigns.stateMachine');
  for (const [from, to] of [['DRAFT', 'SCHEDULED'], ['SCHEDULED', 'RUNNING'], ['RUNNING', 'ENDED']]) assert.doesNotThrow(() => assertTransition(from, to));
  for (const [from, to] of [['DRAFT', 'RUNNING'], ['DRAFT', 'ENDED'], ['SCHEDULED', 'DRAFT'], ['RUNNING', 'SCHEDULED'], ['RUNNING', 'DRAFT'], ['ENDED', 'RUNNING'], ['ENDED', 'DRAFT'], ['SCHEDULED', 'ENDED']]) {
    assert.throws(() => assertTransition(from, to), (e) => {
      assert.equal(e.statusCode, 409);
      assert.equal(e.code, 'MKT_CAMPAIGN_INVALID_TRANSITION');
      assert.equal(e.message, `Transição de campanha inválida: ${from} -> ${to}.`);
      return true;
    });
  }
});

test('exportar_audiencia_nao_existe', async () => {
  const router = require('../src/modules/marketing/campaigns').router;
  const rotas = router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
  assert.deepEqual(rotas.sort(), ['get /marketing/campaigns/:id', 'post /marketing/campaigns']);
  await withRollbackTenantTransaction(A, async (t) => {
    const templateId = await makeTemplate(t, A);
    const { campaign } = await save(t, completeBody({ templateId, personIds: [await makePerson(t, A)], schedule: true }));
    const got = await campaigns.getCampaign(A, campaign.id, t);
    assert.equal(got.audienceSize, 1);
    assert.equal(JSON.stringify(got).includes('personIds'), false, 'a consulta mostra só a contagem');
    assert.equal(got.audiences[0].filter.personIds, undefined);
    assert.equal(got.audiences[0].filter.personCount, 1);
  });
});

test('agendar_acima_do_teto_de_massa_exige_permissao_ou_recusa', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    await upsertSetting('marketing.mass.max_recipients_sem_aprovacao', 2, A, A.userId, t);
    await upsertSetting('marketing.mass.max_recipients_absoluto', 4, A, A.userId, t);
    const templateId = await makeTemplate(t, A);
    const people = [];
    for (let i = 0; i < 5; i += 1) people.push(await makePerson(t, A));
    const body = (n, extra = {}) => completeBody({ templateId, personIds: people.slice(0, n), ...extra, schedule: true });

    // 2 destinatários: dentro do limite, sem permissão de massa
    assert.equal((await save(t, body(2))).campaign.status, 'SCHEDULED');
    // 3: acima do limite sem aprovação -> 403 sem a permissão
    await rejectsWith(assert, save(t, body(3)), 403, 'MKT_MASS_PERMISSION_REQUIRED');
    // com a permissão passa (a permissão é a confirmação explícita)
    assert.equal((await save(t, body(3), WITH_MASS)).campaign.status, 'SCHEDULED');
    // 5: acima do teto absoluto -> 422 mesmo com a permissão
    await rejectsWith(assert, save(t, body(5), WITH_MASS), 422, 'MKT_MASS_LIMIT_EXCEEDED');
    // o mesmo destinatário em duas audiências conta uma vez
    const dup = body(2, { audiences: [
      { kind: 'PERSON_LIST', purpose: 'A', filter: { personIds: people.slice(0, 2) } },
      { kind: 'PERSON_LIST', purpose: 'B', filter: { personIds: people.slice(0, 2) } },
    ] });
    assert.equal((await save(t, dup)).campaign.audienceSize, 2);
  });
});

test('editar_campanha_scheduled_ou_running_e_recusado', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const templateId = await makeTemplate(t, A);
    const people = [await makePerson(t, A)];
    const body = completeBody({ templateId, personIds: people });
    const { campaign } = await save(t, { ...body, schedule: true });
    const edit = { ...body, name: 'Outro nome', campaignId: campaign.id, schedule: true };
    await assert.rejects(save(t, edit), (e) => {
      assert.equal(e.statusCode, 409);
      assert.equal(e.code, 'MKT_CAMPAIGN_NOT_EDITABLE');
      assert.equal(e.message, 'Só campanha em rascunho pode ser alterada; para parar use o kill switch por campanha.');
      return true;
    });
    await rejectsWith(assert, save(t, { campaignId: campaign.id, name: 'Outro nome' }), 409, 'MKT_CAMPAIGN_NOT_EDITABLE');
    // idempotente: repetir o agendamento sem mudar nada devolve 200 e o mesmo estado
    const replay = await save(t, { campaignId: campaign.id, schedule: true });
    assert.equal(replay.created, false);
    assert.equal(replay.replay, true);
    assert.equal(replay.campaign.status, 'SCHEDULED');
    const same = await save(t, { ...body, campaignId: campaign.id, schedule: true });
    assert.equal(same.replay, true);

    await q(t, "UPDATE marketing.campaigns SET status = 'RUNNING' WHERE id = :id", { id: campaign.id });
    await rejectsWith(assert, save(t, edit), 409, 'MKT_CAMPAIGN_NOT_EDITABLE');
    await rejectsWith(assert, save(t, { campaignId: campaign.id, schedule: true }), 409, 'MKT_CAMPAIGN_NOT_EDITABLE');

    await q(t, "UPDATE marketing.campaigns SET status = 'ENDED' WHERE id = :id", { id: campaign.id });
    await assert.rejects(save(t, edit), (e) => {
      assert.equal(e.statusCode, 409);
      assert.equal(e.code, 'MKT_CAMPAIGN_FINAL');
      assert.equal(e.message, 'Campanha encerrada não pode ser alterada.');
      return true;
    });
    // nada mudou
    assert.equal((await loadCampaign(t, campaign.id)).name, 'Lançamento Aurora');
  });
});

test('criar_em_draft_e_completar_por_campaign_id', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const templateId = await makeTemplate(t, A);
    const people = [await makePerson(t, A), await makePerson(t, A)];
    const full = completeBody({ templateId, personIds: people });

    const draft = await save(t, { code: full.code, name: full.name, objective: full.objective });
    assert.equal(draft.created, true);
    assert.equal(draft.campaign.status, 'DRAFT');
    assert.equal(draft.campaign.ownerUserId, A.userId);
    assert.equal(draft.campaign.audienceSize, null, 'o tamanho só congela ao agendar');
    const id = draft.campaign.id;

    // rascunho duplicado (mesmo código) é recusado
    await rejectsWith(assert, save(t, { code: full.code, name: 'x', objective: full.objective }), 409, 'MKT_CAMPAIGN_CODE_DUPLICATE');

    // completar por campaignId sem agendar continua DRAFT; o corpo parcial preserva o que já existe
    const partial = await save(t, { campaignId: id, objectiveMetric: 'VISITS', targetValue: 40, audiences: full.audiences });
    assert.equal(partial.created, false);
    assert.equal(partial.campaign.id, id);
    assert.equal(partial.campaign.status, 'DRAFT');
    assert.equal(partial.campaign.name, full.name);

    // agenda incompleto -> 422 e o rascunho continua DRAFT
    await incomplete(save(t, { campaignId: id, schedule: true }), ['budgetAmount', 'steps', 'startsAt', 'endsAt']);
    assert.equal((await loadCampaign(t, id)).status, 'DRAFT');

    // agenda completo
    const scheduled = await save(t, { ...full, campaignId: id, schedule: true });
    assert.equal(scheduled.created, false);
    assert.equal(scheduled.replay, false);
    assert.equal(scheduled.campaign.id, id);
    assert.equal(scheduled.campaign.status, 'SCHEDULED');
    assert.equal(scheduled.campaign.audienceSize, 2);
    assert.equal((await q(t, 'SELECT count(*)::int AS n FROM marketing.campaigns WHERE id = :id', { id }))[0].n, 1);
    assert.deepEqual((await loadSteps(t, id)).map((s) => s.status), ['SCHEDULED']);
    const audits = await q(t, "SELECT action FROM audit.audit_log WHERE entity_id = :id ORDER BY occurred_at", { id });
    assert.ok(audits.some((a) => a.action === 'marketing.campaign.schedule'));
  });
});

test('publico_segment_e_radar_so_da_propria_empresa', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const templateId = await makeTemplate(t, A);
    const cliente = await makePerson(t, A, { roles: ['CLIENTE'] });
    const owner = await makePerson(t, A, { roles: ['PROPRIETARIO'] });
    const inativo = await makePerson(t, A, { roles: ['CLIENTE'], status: 'INACTIVE' });
    const quente = await makePerson(t, A);
    await makeOpportunity(t, A, quente, { stage: 'NEW', temperature: 'HOT' });
    const comRadar = await makePerson(t, A);
    await makeRadar(t, A, comRadar, { propertyType: 'RESIDENTIAL', city: 'São Paulo' });
    const radarEncerrado = await makePerson(t, A);
    await makeRadar(t, A, radarEncerrado, { propertyType: 'RESIDENTIAL' }, 'CLOSED');
    const alheio = await asTenant(t, A, B, async () => {
      const p = await makePerson(t, B, { roles: ['CLIENTE'] });
      await makeRadar(t, B, p, { propertyType: 'RESIDENTIAL', city: 'São Paulo' });
      return p;
    });
    const run = async (audience) => {
      const r = await save(t, completeBody({ templateId, personIds: [], audiences: [audience], schedule: true, code: `QA-M9-${uid().slice(0, 8)}` }));
      return q(t, 'SELECT person_id FROM marketing.campaign_audience_members WHERE campaign_id = :id', { id: r.campaign.id }).then((rows) => rows.map((x) => x.person_id));
    };
    const byRole = await run({ kind: 'SEGMENT', purpose: 'S', filter: { roles: ['CLIENTE'] } });
    assert.ok(byRole.includes(cliente) && !byRole.includes(owner) && !byRole.includes(inativo) && !byRole.includes(alheio));
    const byOpp = await run({ kind: 'SEGMENT', purpose: 'S', filter: { temperatures: ['HOT'], opportunityStages: ['NEW'] } });
    assert.deepEqual(byOpp, [quente]);
    const radar = await run({ kind: 'RADAR_MATCH', purpose: 'R', filter: { propertyType: 'RESIDENTIAL', city: 'São Paulo' } });
    assert.deepEqual(radar, [comRadar], 'só radar ACTIVE da própria empresa');
    await rejectsWith(assert, save(t, completeBody({ templateId, personIds: [], audiences: [{ kind: 'SEGMENT', purpose: 'S', filter: { cpf: '1' } }], schedule: true })), 400, 'MKT_CAMPAIGN_VALIDATION');
  });
});
