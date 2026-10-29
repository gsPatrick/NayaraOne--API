'use strict';

// Cenário de entregabilidade, opt-out, frequência e automações da M9-D671. Data-base 28/10/2026 12:00 em SP (mês 2026-10; janela de frequência de 7 dias =
// 22/10 a 28/10). Cenário "bom": tudo recebe status de entrega no prazo, sem pedido de saída sem data nem bloqueio sem motivo. Cenário "ruim": mensagem sem status há
// mais de 24 h, mensagem sem destinatário identificável, execução bloqueada sem motivo.
const crypto = require('node:crypto');
const src = require('./m9d627Sources');
const { at } = require('./mktKpiEnv');

const hash = () => crypto.createHash('sha256').update(src.uuid()).digest('hex');
const msg = (env, t, m) => src.insert(env, 'crm.messages', t, {
  person_id: m.person === undefined ? src.uuid() : m.person, channel: m.channel || 'WHATSAPP', direction: m.direction || 'OUTBOUND', author_type: 'NAY', status: m.status,
  action_key: m.actionKey === undefined ? hash() : m.actionKey, purpose: m.purpose === undefined ? 'MARKETING' : m.purpose, created_at: m.at, updated_at: m.at,
});
const delivery = (env, t, d) => src.insert(env, 'marketing.campaign_step_deliveries', t, { campaign_id: d.campaignId, step_id: src.uuid(), person_id: src.uuid(), action_key: d.actionKey, status: 'SENT' });
const optOut = (env, t, o) => src.insert(env, 'marketing.suppression_list', t, {
  person_id: o.person === undefined ? null : o.person, address_hash: hash(), channel: o.channel, reason: o.reason || 'OPT_OUT', source: 'QA-M9', active: true, created_at: o.at, updated_at: o.at,
});
const consent = (env, t, c) => src.insert(env, 'people.communication_consents', t, { person_id: c.person, channel: c.channel, purpose: 'MARKETING', status: 'OPT_OUT', recorded_at: c.at });
const version = (env, t, flowId) => src.insert(env, 'marketing.automation_versions', t, { flow_id: flowId, version_no: 1, trigger_type: 'EVENT', content_hash: hash() });
const run = (env, t, r) => src.insert(env, 'marketing.automation_runs', t, {
  automation_version_id: r.version, correlation_id: src.uuid(), idempotency_key: `QA-M9:${src.uuid()}`, status: r.status, blocked_reason: r.reason || null, actions_result: r.actions || [],
  started_at: r.startedAt, finished_at: r.finishedAt === undefined ? r.startedAt : r.finishedAt, created_at: r.startedAt, updated_at: r.finishedAt || r.startedAt,
});

/** Mensagens de saída do mês. Campanha C1 enviou as duas primeiras do WhatsApp (entregues), via campaign_step_deliveries. */
async function mensagens(env, t, campaignId) {
  const wa = ['DELIVERED', 'DELIVERED', 'DELIVERED', 'DELIVERED', 'DELIVERED', 'DELIVERED', 'READ', 'READ', 'FAILED', 'BOUNCED'];
  const people = Array.from({ length: 8 }, () => src.uuid()); // 10 mensagens para 8 pessoas
  const keys = [];
  for (let i = 0; i < wa.length; i += 1) {
    const actionKey = hash();
    keys.push(actionKey);
    await msg(env, t, { status: wa[i], person: people[i % 8], at: at(i % 2 ? '10-20' : '10-21'), actionKey });
  }
  await delivery(env, t, { campaignId, actionKey: keys[0] });
  await delivery(env, t, { campaignId, actionKey: keys[1] });
  const mail = ['DELIVERED', 'DELIVERED', 'DELIVERED', 'DELIVERED', 'UNDELIVERED'];
  for (const status of mail) await msg(env, t, { status, channel: 'EMAIL', at: at('10-21') });
  await msg(env, t, { status: 'SENT', channel: 'EMAIL', at: at('10-28', '14:00:00') }); // há 1 h: ainda dentro do prazo do status
  await msg(env, t, { status: 'DELIVERED', at: '2026-11-01T02:30:00Z' }); // 23:30 de 31/10 em SP: outubro
  await msg(env, t, { status: 'DELIVERED', at: '2026-11-01T03:30:00Z' }); // 00:30 de 01/11 em SP: novembro
  await msg(env, t, { status: 'DELIVERED', actionKey: null, purpose: null, at: at('10-21') }); // manual: sem action_key
  await msg(env, t, { status: 'RECEIVED', direction: 'INBOUND', actionKey: null, purpose: null, at: at('10-21') });
}

/** Frequência (janela 22/10 a 28/10): F1 4 mensagens de WhatsApp (acima do teto de 3), F2 2, F3 1 de e-mail. */
async function frequencia(env, t) {
  const [f1, f2, f3] = [src.uuid(), src.uuid(), src.uuid()];
  for (const d of ['10-22', '10-24', '10-26', '10-28']) await msg(env, t, { status: 'DELIVERED', person: f1, at: at(d) });
  for (const d of ['10-23', '10-27']) await msg(env, t, { status: 'DELIVERED', person: f2, at: at(d) });
  await msg(env, t, { status: 'DELIVERED', person: f3, channel: 'EMAIL', at: at('10-25') });
  await msg(env, t, { status: 'DELIVERED', person: f1, at: at('10-21', '12:00:00') }); // antes da janela
}

/** Opt-out de outubro: WhatsApp = pessoa A (dois endereços), pessoa B, um endereço sem pessoa; B também no consentimento; e-mail = pessoa C só no consentimento. */
async function optOuts(env, t) {
  const [a, b, c] = [src.uuid(), src.uuid(), src.uuid()];
  await optOut(env, t, { person: a, channel: 'WHATSAPP', at: at('10-05') });
  await optOut(env, t, { person: a, channel: 'WHATSAPP', at: at('10-06') });
  await optOut(env, t, { person: b, channel: 'WHATSAPP', at: at('10-07') });
  await optOut(env, t, { channel: 'WHATSAPP', at: at('10-08') });
  await optOut(env, t, { person: src.uuid(), channel: 'WHATSAPP', reason: 'BOUNCE', at: at('10-09') }); // outro motivo: não é pedido de saída
  await optOut(env, t, { person: src.uuid(), channel: 'WHATSAPP', at: at('09-30') }); // setembro
  await consent(env, t, { person: b, channel: 'WHATSAPP', at: at('10-07') });
  await consent(env, t, { person: c, channel: 'EMAIL', at: at('10-10') });
}

/** Automações de outubro: A (2 execuções ok, 1 bloqueada por NO_CONSENT, 1 por FREQUENCY_CAP, 1 adiada por QUIET_HOURS que não conta) e B (1 ok, 1 com falha ADAPTER_TIMEOUT, 1 com falha sem código). */
async function automacoes(env, t) {
  const [flowA, flowB] = [src.uuid(), src.uuid()];
  const [va, vb] = [await version(env, t, flowA), await version(env, t, flowB)];
  const ok = (v, d) => run(env, t, { version: v, status: 'COMPLETED', startedAt: at(d) });
  await ok(va, '10-02'); await ok(va, '10-03'); await ok(vb, '10-04');
  await run(env, t, { version: va, status: 'BLOCKED', reason: 'NO_CONSENT', startedAt: at('10-05') });
  await run(env, t, { version: va, status: 'BLOCKED', reason: 'FREQUENCY_CAP', startedAt: at('10-06') });
  await run(env, t, { version: va, status: 'BLOCKED', reason: 'QUIET_HOURS', startedAt: at('10-07') });
  await run(env, t, { version: vb, status: 'FAILED', startedAt: at('10-08'), actions: [{ action_key: hash(), status: 'FAILED', error_code: 'ADAPTER_TIMEOUT' }] });
  await run(env, t, { version: vb, status: 'FAILED', startedAt: at('10-09') });
  await run(env, t, { version: vb, status: 'COMPLETED', startedAt: at('09-30') }); // setembro
  return { flowA, flowB };
}

async function bom(env, t, campaignId) {
  await mensagens(env, t, campaignId);
  await frequencia(env, t);
  await optOuts(env, t);
  return automacoes(env, t);
}

async function ruim(env, t) {
  await msg(env, t, { status: 'SENT', at: at('10-25') }); // sem status de entrega há mais de 24 h
  await msg(env, t, { status: 'DELIVERED', person: null, at: at('10-27') }); // sem destinatário identificável
  const v = await version(env, t, src.uuid());
  await run(env, t, { version: v, status: 'BLOCKED', reason: null, startedAt: at('10-05') });
  await run(env, t, { version: v, status: 'COMPLETED', startedAt: at('10-06') });
  await optOut(env, t, { person: src.uuid(), channel: 'WHATSAPP', at: at('10-05') });
}

module.exports = { msg, optOut, run, bom, ruim, mensagens, frequencia, optOuts, automacoes, hash };
