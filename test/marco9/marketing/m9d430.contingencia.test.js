'use strict';

// M9-D430 — a contingência de cada canal tem UMA dona (esta demanda) e aponta para o modo do bloco B, sem criar modo próprio:
// WHATSAPP = QUEUE_AND_ALTERNATE (M9-D226/M9-D227); EMAIL = nova tentativa por classe de erro (M9-D216); SITE e PORTAL = publicação interna
// mantida e reprocessada (PENDING_SYNC; M9-D259/M9-D227); redes = falha isolada, sem fila alternativa (M9-D410/M9-D216).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { MODES, FAMILY_DEFAULT_MODE, MODES_WITH_ALTERNATE } = require('../../../src/features/integrations/contingency/contingency.constants');
const adapters = require('../../../src/features/marketing/publications/adapters');
const env = require('../_helpers/mktChannelEnv');

const { CHANNELS, planFor, decideOnResult, fanOut, isQueueExpired, resetSandbox } = adapters;
let A;
before(async () => { ({ tenantA: A } = await prepararTenants()); });
after(async () => { await sequelize.close(); });
beforeEach(() => resetSandbox());

const SOCIAIS = ['INSTAGRAM', 'FACEBOOK', 'LINKEDIN', 'YOUTUBE', 'TIKTOK'];
const falha = async (canal, scenario) => env.sandboxFor(canal)[env.operationOf(canal)](env.payload(), { idempotencyKey: `chave-cont-${canal}-${scenario}`, scenario });

test('contingencia_de_canal_usa_o_modo_do_bloco_b_e_nao_cria_modo_proprio', async () => {
  for (const canal of CHANNELS) {
    const plano = planFor(canal);
    assert.equal(plano.owner, 'M9-D430');
    if (plano.mode !== null) assert.ok(MODES.includes(plano.mode), `${canal}: o modo ${plano.mode} é do bloco B`);
  }
  // WHATSAPP: o modo padrão da família é lido do framework, não escrito aqui
  assert.equal(planFor('WHATSAPP').mode, FAMILY_DEFAULT_MODE.MESSAGING);
  assert.equal(planFor('WHATSAPP').mode, 'QUEUE_AND_ALTERNATE');
  assert.equal(planFor('PORTAL').mode, FAMILY_DEFAULT_MODE.PORTAL);
  assert.equal(planFor('SITE').mode, 'KEEP_INTERNAL_AND_REPROCESS');
  assert.ok(MODES_WITH_ALTERNATE.includes(planFor('WHATSAPP').mode));
  for (const canal of ['EMAIL', ...SOCIAIS]) assert.equal(planFor(canal).mode, null, `${canal} usa só a nova tentativa por classe (M9-D216)`);
  for (const canal of SOCIAIS) assert.deepEqual([planFor(canal).alternate, planFor(canal).isolated, planFor(canal).retry], [false, true, 'BY_ERROR_CLASS']);
  assert.equal(planFor('EMAIL').retry, 'BY_ERROR_CLASS');
  assert.deepEqual(planFor('WHATSAPP').alternate, { allowed: true, requiresConsent: true });
  assert.deepEqual(planFor('SITE').refs, ['M9-D259']);
  assert.ok(planFor('PORTAL').refs.includes('M9-D227'));
  // o Marketing não registra gancho nem ativa contingência no framework
  const raiz = path.join(__dirname, '../../../src/features/marketing');
  const fontes = fs.readdirSync(raiz, { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(raiz, f), 'utf8')).join('\n');
  assert.ok(!/registerContingencyHandler|activateContingency|FAMILY_DEFAULT_MODE\s*\[[^\]]+\]\s*=|MODES\.push/.test(fontes), 'sem modo próprio de contingência');
  assert.throws(() => planFor('ORKUT'), (e) => e.code === 'MKT_VALIDATION');
});

test('whatsapp_indisponivel_fica_em_fila_e_nunca_e_marcada_entregue', async () => {
  for (const scenario of ['HTTP_5XX', 'HTTP_429']) {
    const r = await falha('WHATSAPP', scenario);
    const d = decideOnResult('WHATSAPP', r);
    assert.deepEqual([d.action, d.state, d.delivered], ['QUEUE', 'QUEUED', false], scenario);
    assert.equal(d.alternate.requiresConsent, true, 'o canal alternativo só com consentimento');
    assert.equal(d.mode, 'QUEUE_AND_ALTERNATE');
  }
  const incerta = decideOnResult('WHATSAPP', await falha('WHATSAPP', 'TIMEOUT'));
  assert.deepEqual([incerta.action, incerta.state, incerta.delivered], ['RECONCILE_FIRST', 'QUEUED', false], 'incerta: consulta antes de repetir e segue fora de "entregue"');
  const ok = decideOnResult('WHATSAPP', await falha('WHATSAPP', 'OK'));
  assert.deepEqual([ok.action, ok.state], ['NONE', 'SENT']);
  const rejeitada = decideOnResult('WHATSAPP', await falha('WHATSAPP', 'REJECTED'));
  assert.deepEqual([rejeitada.action, rejeitada.state, rejeitada.delivered], ['REJECT', 'REJECTED', false], 'rejeição é definitiva: não entra em fila');
});

test('whatsapp_de_marketing_que_vence_a_idade_maxima_da_fila_e_cancelada: o prazo vem do parâmetro do modo do bloco B', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    await upsertSetting('integration.contingency.queue_max_age_h.QUEUE_AND_ALTERNATE', 6, A, A.userId, t);
    const queuedAt = new Date('2026-11-09T10:00:00Z');
    assert.equal(await isQueueExpired({ queuedAt, now: new Date('2026-11-09T15:59:59Z') }, A, t), false);
    assert.equal(await isQueueExpired({ queuedAt, now: new Date('2026-11-09T16:00:01Z') }, A, t), true);
    const venceu = decideOnResult('WHATSAPP', await falha('WHATSAPP', 'HTTP_5XX'), { queuedAt, now: new Date('2026-11-09T17:00:00Z'), queueExpired: true });
    assert.deepEqual([venceu.action, venceu.state], ['CANCEL_QUEUED', 'CANCELLED']);
  });
});

test('site_e_portal_indisponiveis_mantem_a_publicacao_interna_em_PENDING_SYNC_e_reprocessa', async () => {
  for (const canal of ['SITE', 'PORTAL']) {
    for (const scenario of ['HTTP_5XX', 'TIMEOUT']) {
      const d = decideOnResult(canal, await falha(canal, scenario));
      assert.deepEqual([d.action, d.state, d.keepInternal, d.reprocess], ['KEEP_INTERNAL', 'PENDING_SYNC', true, true], `${canal} ${scenario}`);
      assert.equal(d.mode, 'KEEP_INTERNAL_AND_REPROCESS');
    }
    assert.equal(decideOnResult(canal, await falha(canal, 'OK')).state, 'PUBLISHED');
  }
});

test('rede_social_com_falha_nao_bloqueia_as_demais: falha isolada e nova tentativa por classe, sem fila alternativa', async () => {
  const pedidos = SOCIAIS.map((canal, i) => ({ channel: canal, message: env.payload({ n: i }), idempotencyKey: `chave-fan-${canal}`, scenario: canal === 'FACEBOOK' ? 'HTTP_5XX' : (canal === 'TIKTOK' ? 'AUTH_REVOKED' : undefined) }));
  const saida = await fanOut(pedidos, { adapterFor: async (canal) => env.sandboxFor(canal) });
  assert.deepEqual(saida.map((s) => [s.channel, s.result.status]), [['INSTAGRAM', 'PUBLISHED'], ['FACEBOOK', 'FAILED'], ['LINKEDIN', 'PUBLISHED'], ['YOUTUBE', 'PUBLISHED'], ['TIKTOK', 'FAILED']]);
  const fb = saida[1].contingency;
  assert.deepEqual([fb.action, fb.blocksOthers, fb.alternate, fb.retry, fb.state], ['ISOLATE_AND_RETRY', false, false, 'BY_ERROR_CLASS', 'FAILED']);
  assert.equal(saida[4].contingency.retry, 'NONE', 'credencial recusada não entra em laço (classe AUTH)');
  assert.equal(saida[0].contingency.action, 'NONE');
  // um adapter que lança também fica isolado
  const lancando = await fanOut(
    [{ channel: 'INSTAGRAM', message: env.payload(), idempotencyKey: 'chave-fan-boom-1' }, { channel: 'YOUTUBE', message: env.payload(), idempotencyKey: 'chave-fan-boom-2' }],
    { adapterFor: async (canal) => (canal === 'INSTAGRAM' ? { isSandbox: true, publish: async () => { throw new Error('rede caiu'); } } : env.sandboxFor(canal)) },
  );
  assert.equal(lancando[0].result, null);
  assert.equal(lancando[0].contingency.action, 'ISOLATE_AND_RETRY');
  assert.equal(lancando[1].result.status, 'PUBLISHED');
});

test('email_falho_repete_por_classe_de_erro: transitório e limite repetem, validação e credencial não', async () => {
  const retry = async (scenario) => decideOnResult('EMAIL', await falha('EMAIL', scenario)).retry;
  const unknown = decideOnResult('EMAIL', await falha('EMAIL', 'UNKNOWN_NOT_PUBLISHED'));
  assert.deepEqual([unknown.action, unknown.state], ['RECONCILE_FIRST', 'UNKNOWN'], 'incerto consulta antes de repetir (M9-D411)');
  assert.equal(await retry('HTTP_5XX'), 'BY_ERROR_CLASS');
  assert.equal(await retry('HTTP_429'), 'BY_ERROR_CLASS');
  assert.equal(await retry('REJECTED'), 'NONE');
  assert.equal(await retry('AUTH_REVOKED'), 'NONE');
});
