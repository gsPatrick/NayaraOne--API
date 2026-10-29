'use strict';

// M9-D671 — os quatro KPIs de Marketing (entregabilidade, opt-out, frequência, automações) recalculados do zero SÓ com as linhas-fonte (oráculo: consultas diretas ao
// OLTP) e comparados com o que o BI calcula pelos read models; cada regra de qualidade violada deixa DEGRADED/INCOMPLETE, sem valor; os parâmetros do administrador
// (janela da frequência, horas sem status de entrega) mudam o resultado. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/mktKpiEnv');
const sc = require('../_helpers/m9d671Scenario');
const oracle = require('../_helpers/m9d671Oracle');

const MONTH = '2026-10';
let env;
let good;
let bad;
before(async () => {
  env = await kit.setup();
  const campaignId = kit.src.uuid();
  env.flows = await sc.bom(env, env.cX, campaignId);
  env.campaignId = campaignId;
  await sc.ruim(env, env.cY);
  await kit.refreshAll(env, env.cX);
  await kit.refreshAll(env, env.cY, { viaEvent: ['rm_mkt_frequency'] });
  good = (await kit.kpis(env.cX)).kpis;
  bad = (await kit.kpis(env.cY)).kpis;
});
after(() => kit.teardown(env));

const dims = (r) => Object.fromEntries(r.dimensions.map((d) => [d.key, d.value]));
const noValue = (r, status, reason) => {
  assert.equal(r.status, status);
  assert.equal(r.value, null);
  assert.equal(r.message, 'Dado incompleto, valor não confiável.');
  assert.equal(r.details.reason, reason);
};

test('m9d671 reproduz mkt.deliverability a partir dos registros-fonte', async () => {
  const want = await oracle.deliveryFromSource(env, env.cX, MONTH);
  const r = good['mkt.deliverability'];
  assert.equal(r.status, 'OK');
  assert.equal(r.value, oracle.pct(want.delivered, want.sent));
  assert.deepEqual([r.details.sent, r.details.delivered, r.details.failed, r.details.bounced], [String(want.sent), String(want.delivered), String(want.failed), String(want.bounced)]);
  assert.deepEqual([want.sent, want.delivered, want.failed, want.bounced], [25, 21, 2, 1], 'WhatsApp 10 + 1 de 31/10 23:30 + 7 da frequência, e-mail 6 + 1; manual, recebida e 00:30 de 01/11 ficam de fora');
  for (const [channel, v] of Object.entries(want.by)) assert.equal(dims(r)[`canal:${channel}:entregabilidade_pct`], oracle.pct(v.delivered, v.sent), channel);
  assert.equal(dims(r)[`campanha:${env.campaignId}:entregabilidade_pct`], '100.00', 'a campanha enviou 2 mensagens, as 2 entregues');
  assert.equal(Number(await kit.dimension(env.cX, 'mkt.deliverability', 'devolvidas_qtd')), 1, 'o snapshot gravado traz a mesma dimensão');
});

test('m9d671 mkt.deliverability fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  noValue(bad['mkt.deliverability'], 'DEGRADED', 'ENTREGA_SEM_STATUS_ALEM_DO_LIMITE');
  assert.equal((await oracle.deliveryFromSource(env, env.cY, MONTH)).awaiting, Date.parse('2026-10-25T15:00:00Z'));
  // o limite de horas é do administrador: 72 h sem status com limite de 100 h mantém o valor
  await kit.setSetting(env, env.cY, 'analytics.qualidade.mkt_entrega_max_horas', 100);
  const relaxed = (await kit.kpis(env.cY)).kpis['mkt.deliverability'];
  assert.equal(relaxed.status, 'OK');
  assert.equal(relaxed.value, '50.00', '1 entregue de 2 enviadas');
  await kit.setSetting(env, env.cY, 'analytics.qualidade.mkt_entrega_max_horas', 24);
});

test('m9d671 reproduz mkt.opt_out a partir dos registros-fonte', async () => {
  const want = await oracle.optOutFromSource(env, env.cX, MONTH);
  const r = good['mkt.opt_out'];
  assert.equal(r.status, 'OK');
  assert.equal(r.value, oracle.pct(want.optOuts, want.reached));
  assert.deepEqual([r.details.reached, r.details.optOuts], [String(want.reached), String(want.optOuts)]);
  assert.equal(want.by.WHATSAPP.optOuts, 3, 'pessoa A (dois endereços) = 1, pessoa B (também no consentimento) = 1 e o endereço sem pessoa = 1');
  assert.equal(want.by.EMAIL.optOuts, 1, 'pessoa C só no consentimento');
  for (const [channel, v] of Object.entries(want.by)) if (v.reached) assert.equal(dims(r)[`canal:${channel}:taxa_pct`], oracle.pct(v.optOuts, v.reached), channel);
  assert.equal(dims(r).saidas_qtd, String(want.optOuts));
});

test('m9d671 mkt.opt_out fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  // a completude de `created_at` reprova o rebuild do mês (como deve), então o estado entra pelo evento do dia-base. A tabela exige a data do pedido; para provar a regra "opt-out sem data" ela é relaxada só durante o teste, no banco descartável
  await env.admin.query('ALTER TABLE marketing.suppression_list ALTER COLUMN created_at DROP NOT NULL');
  let undatedId;
  try {
    undatedId = await kit.src.insert(env, 'marketing.suppression_list', env.cY, { address_hash: sc.hash(), channel: 'WHATSAPP', reason: 'OPT_OUT', source: 'QA-M9', active: true, created_at: null, updated_at: new Date() });
    await kit.refreshAll(env, env.cY, { viaEvent: ['rm_mkt_frequency', 'rm_mkt_optout_month'] });
    const r = (await kit.kpis(env.cY)).kpis['mkt.opt_out'];
    noValue(r, 'DEGRADED', 'OPT_OUT_SEM_DATA');
    assert.equal(r.details.undated, '1');
  } finally {
    if (undatedId) await env.admin.query('DELETE FROM marketing.suppression_list WHERE id = :id', { replacements: { id: undatedId } });
    await env.admin.query('ALTER TABLE marketing.suppression_list ALTER COLUMN created_at SET NOT NULL');
  }
  await kit.refreshAll(env, env.cY, { viaEvent: ['rm_mkt_frequency', 'rm_mkt_optout_month'] });
  assert.equal((await kit.kpis(env.cY)).kpis['mkt.opt_out'].status, 'OK');
});

test('m9d671 reproduz mkt.frequency a partir dos registros-fonte', async () => {
  const want = await oracle.frequencyFromSource(env, env.cX, '2026-10-28', 7);
  const r = good['mkt.frequency'];
  assert.equal(r.status, 'OK');
  assert.equal(r.value, (Math.round((want.messages * 100) / want.people) / 100).toFixed(2));
  assert.deepEqual([r.details.messages, r.details.people, r.details.overCap], [String(want.messages), String(want.people), String(want.over)]);
  assert.equal(want.over, 1, 'F1 recebeu 4 mensagens de WhatsApp na janela, acima do teto de 3 por 7 dias');
  for (const [channel, v] of Object.entries(want.byChannel)) assert.equal(dims(r)[`canal:${channel}:media`], (Math.round((v.messages * 100) / v.people.size) / 100).toFixed(2), channel);
  assert.equal(Number(await kit.dimension(env.cX, 'mkt.frequency', 'acima_do_teto_qtd')), 1);
});

test('m9d671 mkt.frequency fica DEGRADED com valor nulo quando a regra de qualidade falha', () => {
  noValue(bad['mkt.frequency'], 'DEGRADED', 'MENSAGEM_SEM_DESTINATARIO');
  assert.equal(bad['mkt.frequency'].details.unidentified, '1');
});

test('m9d671 a janela da frequência é parâmetro: janela diferente da calculada deixa INCOMPLETE até o recálculo, e o recálculo usa a nova', async () => {
  await kit.setSetting(env, env.cX, 'analytics.frequencia.janela_dias', 14);
  const stale = (await kit.kpis(env.cX)).kpis['mkt.frequency'];
  noValue(stale, 'INCOMPLETE', 'JANELA_DESATUALIZADA');
  await kit.refreshAll(env, env.cX);
  const wider = (await kit.kpis(env.cX)).kpis['mkt.frequency'];
  const want = await oracle.frequencyFromSource(env, env.cX, '2026-10-28', 14);
  assert.equal(wider.status, 'OK');
  assert.deepEqual([wider.details.windowDays, wider.details.messages, wider.details.people], ['14', String(want.messages), String(want.people)]);
  await kit.setSetting(env, env.cX, 'analytics.frequencia.janela_dias', 7);
  await kit.refreshAll(env, env.cX);
  assert.equal((await kit.kpis(env.cX)).kpis['mkt.frequency'].details.windowDays, '7');
});

test('m9d671 reproduz mkt.automations_blocked_failed a partir dos registros-fonte', async () => {
  const want = await oracle.automationsFromSource(env, env.cX, MONTH);
  const r = good['mkt.automations_blocked_failed'];
  assert.equal(r.status, 'OK');
  assert.equal(r.value, String(want.total));
  assert.deepEqual([r.details.total, r.details.blocked, r.details.failed], [String(want.total), String(want.blocked), String(want.failed)]);
  assert.deepEqual([want.total, want.blocked, want.failed], [8, 2, 2], 'QUIET_HOURS é adiamento e não conta; a execução de setembro fica de fora');
  assert.equal(r.details.blockedPct, oracle.pct(want.blocked, want.total));
  assert.equal(r.details.failedPct, oracle.pct(want.failed, want.total));
  assert.deepEqual(r.details.byReason.map((x) => [x.reason, x.count]), Object.entries(want.byReason).sort().map(([k, v]) => [k, String(v)]));
  assert.deepEqual(r.details.byErrorCode.map((x) => [x.code, x.count]), Object.entries(want.byCode).sort().map(([k, v]) => [k, String(v)]));
  assert.equal(dims(r)[`automacao:${env.flows.flowB}:falhas_qtd`], '2');
  assert.equal(dims(r)[`automacao:${env.flows.flowA}:bloqueadas_qtd`], '2');
});

test('m9d671 mkt.automations_blocked_failed fica DEGRADED com valor nulo quando a regra de qualidade falha', () => {
  noValue(bad['mkt.automations_blocked_failed'], 'DEGRADED', 'BLOQUEIO_SEM_MOTIVO');
  assert.equal(bad['mkt.automations_blocked_failed'].details.blockedWithoutReason, '1');
});

test('m9d671 a agenda recalcula o dia de hoje da frequência mesmo sem mensagem nele: a janela anda com o relógio', async () => {
  const later = new Date('2026-10-30T15:00:00Z'); // 30/10: nenhuma mensagem nova, mas a janela de 7 dias (24 a 30/10) ainda alcança as de 24 a 28
  await kit.runSchedule(env.cX, later);
  const [[row]] = await env.admin.query("SELECT window_days, window_messages, window_people FROM analytics.rm_mkt_frequency WHERE company_id = :c AND day = '2026-10-30'", { replacements: { c: env.cX.companyId } });
  const want = await oracle.frequencyFromSource(env, env.cX, '2026-10-30', 7);
  assert.ok(row, 'a linha de 30/10 nasceu pela agenda');
  assert.deepEqual([row.window_days, row.window_messages, row.window_people], [7, want.messages, want.people]);
  assert.ok(want.messages > 0);
  const [[none]] = await env.admin.query("SELECT count(*)::int AS n FROM analytics.rm_mkt_frequency WHERE company_id = :c", { replacements: { c: env.cZ ? env.cZ.companyId : env.tenantB.companyId } });
  assert.equal(none.n, 0, 'empresa sem mensagem de marketing não ganha linha');
});
