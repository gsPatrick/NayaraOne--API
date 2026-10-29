'use strict';

// M9-D419 — métricas sem violar a privacidade: person_hash pseudonimizado por empresa (segredo do cofre), público alcançável sem
// suprimidos nem opt-outs, resumo de alcance só com contagens, identificação de clique só com consentimento do canal e nenhuma
// exportação de lista de contatos. Banco descartável; rollback; duas empresas.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const campaigns = require('../../../src/features/marketing/campaigns/campaigns.service');
const lifecycle = require('../../../src/features/marketing/campaigns/lifecycle.service');
const { registerCampaignSendPort, clearCampaignSendPort } = require('../../../src/features/marketing/campaigns/sendPort');
const sup = require('../../../src/features/marketing/suppression');
const env = require('../_helpers/mktOptOut');
const { useTempSecretStore } = require('../_helpers/mktSecretStore');

const { readyPerson, makeTemplate, completeBody, addConsent, q } = env;
let A;
let B;
let dropStore;
before(async () => { ({ a: A, b: B } = await env.tenants()); dropStore = useTempSecretStore(); });
after(async () => { clearCampaignSendPort(); dropStore(); await sequelize.close(); });
const HEX64 = /^[0-9a-f]{64}$/;

test('person_hash_e_sha256_de_pessoa_dois_pontos_segredo_estavel_por_empresa_e_diferente_entre_empresas', async () => {
  const p = env.uid();
  const [hashA1, hashA2, hashB] = [await sup.personHash(p, A), await sup.personHash(p, A), await sup.personHash(p, B)];
  assert.match(hashA1, HEX64);
  assert.equal(hashA1, hashA2, 'estável por empresa');
  assert.notEqual(hashA1, hashB, 'o segredo é de cada empresa: o mesmo id gera outro hash');
  assert.notEqual(hashA1, crypto.createHash('sha256').update(p).digest('hex'), 'não é o hash puro do id');
  const salt = await sup.personHashSalt(A);
  assert.equal(hashA1, crypto.createHash('sha256').update(`${p}:${salt}`).digest('hex'));
  assert.ok(salt.length >= 32);
});

async function scheduled(t, personIds) {
  const templateId = await makeTemplate(t, A);
  const body = completeBody({ templateId, personIds, startsAt: '2031-12-01T09:00:00', endsAt: '2031-12-10T18:00:00', audiences: [{ kind: 'PERSON_LIST', purpose: 'MARKETING', filter: { personIds } }] });
  return (await campaigns.saveCampaign(A, A.userId, { ...body, schedule: true }, { permissions: ['marketing:campaign:manage'] }, t)).campaign;
}

test('publico_alcancavel_exclui_suprimidos_e_opt_outs_e_o_resumo_so_tem_contagens', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const ok = await readyPerson(t, A);
    const suppressed = await readyPerson(t, A);
    const optedOut = await readyPerson(t, A);
    const noAddress = await env.makePerson(t, A);
    await sup.service.suppress({ personId: suppressed, channel: 'EMAIL', reason: 'BOUNCE', source: 'QA-M9' }, A, t);
    await addConsent(t, A, optedOut, 'EMAIL', 'ALL', 'OPT_OUT', new Date());
    const campaign = await scheduled(t, [ok, suppressed, optedOut, noAddress]);
    registerCampaignSendPort(sup.buildCampaignSendPort({ send: async () => ({ ok: true, externalRef: 'm' }) }));
    await lifecycle.runLifecycleTick(A, t, new Date('2031-12-01T12:00:10Z'));
    const view = await campaigns.getCampaign(A, campaign.id, t);
    const reach = view.reach;
    assert.deepEqual(reach, { audienceSize: 4, reachable: 1, excludedSuppressed: 1, excludedOptOut: 1, excludedNoAddress: 1, delivered: 1, uniqueReach: 1, clicks: 0, conversions: 0 });
    const wire = JSON.stringify(view);
    for (const id of [ok, suppressed, optedOut, noAddress]) assert.ok(!wire.includes(id), 'nenhum identificador de pessoa na resposta');
    assert.ok(!/[0-9a-f]{64}/.test(JSON.stringify(reach)), 'nem hash');
    // o resumo conta alcance distinto pelo person_hash, não pelo id
    const direct = await sup.reachable.countReachable({ campaignId: campaign.id, channel: 'EMAIL' }, A, t);
    assert.equal(direct.reachable, 1);
    const [row] = await q(t, `SELECT count(DISTINCT encode(sha256(convert_to(person_id::text || ':' || :salt, 'UTF8')), 'hex'))::int AS n
      FROM marketing.campaign_step_deliveries WHERE campaign_id = :c AND status = 'SENT'`, { c: campaign.id, salt: await sup.personHashSalt(A) });
    assert.equal(row.n, reach.uniqueReach);
  });
});

test('clique_sem_consentimento_nao_grava_pessoa', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const consented = await readyPerson(t, A);
    const noConsent = await readyPerson(t, A, { optIn: [] });
    const optedOut = await readyPerson(t, A);
    await addConsent(t, A, optedOut, 'EMAIL', 'ALL', 'OPT_OUT', new Date());
    const suppressed = await readyPerson(t, A);
    await sup.service.suppress({ personId: suppressed, channel: 'EMAIL', reason: 'BOUNCE', source: 'QA-M9' }, A, t);
    const may = (p) => sup.trackingConsent.mayIdentify(p, 'EMAIL', A, t);
    assert.deepEqual(await may(consented), { identify: true, reason: null });
    assert.deepEqual(await may(noConsent), { identify: false, reason: 'NO_CONSENT' });
    assert.deepEqual(await may(optedOut), { identify: false, reason: 'OPT_OUT' });
    assert.deepEqual(await may(suppressed), { identify: false, reason: 'SUPPRESSED' });
  });
});

test('exportar_lista_de_campanha_nao_existe', async () => {
  const { areas } = require('../../../src/features/marketing');
  const paths = [];
  const walk = (stack) => {
    for (const layer of stack || []) {
      if (layer.route) paths.push(...Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${layer.route.path}`));
      else if (layer.handle && layer.handle.stack) walk(layer.handle.stack);
    }
  };
  for (const area of Object.values(areas)) walk(area.router.stack);
  assert.ok(paths.length >= 8, `as rotas do Marketing foram lidas (${paths.length})`);
  assert.deepEqual(paths.filter((p) => /export|download|csv|xlsx|lista-de-contatos|contacts|members/i.test(p)), [], 'nenhuma rota de exportação de lista');
  const campaignApi = Object.keys(require('../../../src/features/marketing/campaigns/audience.service')).concat(Object.keys(require('../../../src/features/marketing/campaigns/campaigns.dto')));
  assert.ok(!campaignApi.some((name) => /export/i.test(name)));
  const A2 = await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    const campaign = await scheduled(t, [p]);
    return JSON.stringify(await campaigns.getCampaign(A, campaign.id, t)).includes(p);
  });
  assert.equal(A2, false, 'a consulta da campanha só mostra a contagem de pessoas');
});
