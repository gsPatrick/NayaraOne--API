'use strict';

const crypto = require('node:crypto');
const messaging = require('../messaging');
const { IntegrationConnection } = require('../../../../models');
const health = require('../../../integrations/health');
const { resolveChannelConnection } = require('../schedule/schedule.connection');
const { SLOW_MS_KEY } = require('../adapters/channel.settings');
const { KEYS: WORKER } = require('../worker/worker.settings');
const { isOutboundBlocked } = require('../../killswitch.state');
const { setParam } = require('./drill.fixture');
const { prepare, posts, seconds, MS } = require('./drill.cycle');
const { query } = require('./drill.env');
const { installCallCounter } = require('./drill.probe');
const { readDrillParams } = require('./drill.settings');

/**
 * M9-D442 — os cenários de falha na MENSAGEM DIRETA (WhatsApp e e-mail), que não passa pelo worker de publicação: sendMarketingMessage -> sendToChannel -> sandbox. O pedido é
 * pré-autorizado (o runner já decidiu kill switch e canSend, que não são assunto do ensaio) e a chave de ação é a chave de idempotência. Mesmas regras do livro: resposta incerta fica
 * UNKNOWN e a mesma chave confere o canal antes de repetir; recusa e credencial não repetem; o circuito da conexão segura o que ainda não saiu.
 */
const HALF_OPEN_KEY = 'integration.circuit.half_open_max_calls';
const newKey = () => crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'); // o CRM exige a chave de ação em hexadecimal

async function person(t, env) {
  const [p] = await query(t, "INSERT INTO people.persons (id, group_id, company_id, person_type, legal_name, status) VALUES (gen_random_uuid(), :g, :c, 'PF', 'Failure drill', 'ACTIVE') RETURNING id", { g: env.tenant.groupId, c: env.tenant.companyId });
  const type = env.channel;
  const value = type === 'EMAIL' ? `drill-${crypto.randomUUID().slice(0, 8)}@exemplo.test` : `1199${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  await query(t, 'INSERT INTO people.person_contacts (id, group_id, company_id, person_id, contact_type, value_normalized, is_primary) VALUES (gen_random_uuid(), :g, :c, :p, :ty, :v, true) RETURNING id', { g: env.tenant.groupId, c: env.tenant.companyId, p: p.id, ty: type, v: value });
  return p.id;
}

const send = (t, env, personId, key, { scenario, now = new Date() } = {}) => messaging.sendMarketingMessage(
  { tenant: env.tenant, transaction: t, now, mode: 'SANDBOX', scenario, preAuthorized: true },
  { channel: env.channel, personId, purpose: 'TRANSACTIONAL', actionKey: key, text: 'Olá, temos novidades para você.', subject: 'Novidades' },
);
const rows = (t, env, key) => query(t, 'SELECT status, delivery_status FROM crm.messages WHERE company_id = :c AND action_key = :k', { c: env.tenant.companyId, k: key });

async function baseline(t, env) {
  await prepare(t, env);
  const p = await person(t, env);
  const key = newKey();
  const out = await send(t, env, p, key);
  return { ok: out.status === 'SENT' && posts(env) === 1 && (await rows(t, env, key)).length === 1, obtained: `mensagem ${out.status}, ${posts(env)} post, ${(await rows(t, env, key)).length} linha no CRM` };
}

/** Resposta incerta e reenvio da MESMA chave: confere o canal antes de repetir e nunca existe segunda mensagem nem segundo post. */
async function uncertain(t, env, scenario, expectFound) {
  await prepare(t, env);
  const p = await person(t, env);
  const key = newKey();
  const first = await send(t, env, p, key, { scenario });
  const second = await send(t, env, p, key);
  const count = (await rows(t, env, key)).length;
  const reconciled = second.reconciled === true;
  const ok = first.status === 'UNKNOWN' && second.status === 'SENT' && posts(env) === 1 && count === 1 && (expectFound === null || reconciled === expectFound);
  return { ok, obtained: `1º envio ${first.status}; mesma chave: ${second.status}${reconciled ? ' (conferido no canal, já estava lá)' : ' (reenviado após conferir)'}; ${posts(env)} post, ${count} mensagem no CRM` };
}

const timeout = (t, env) => uncertain(t, env, 'TIMEOUT', null);
const unknownButPublished = (t, env) => uncertain(t, env, 'UNKNOWN_BUT_PUBLISHED', true);
const unknownNotPublished = (t, env) => uncertain(t, env, 'UNKNOWN_NOT_PUBLISHED', false);

async function duplicateKey(t, env) {
  await prepare(t, env);
  const p = await person(t, env);
  const key = newKey();
  const first = await send(t, env, p, key, { scenario: 'DUPLICATE_KEY' });
  const again = await send(t, env, p, key);
  const count = (await rows(t, env, key)).length;
  const ok = first.status === 'SENT' && again.replayed === true && again.providerRef === first.providerRef && posts(env) === 1 && count === 1;
  return { ok, obtained: `${first.status}; repetição da chave: mesma resposta (replay=${again.replayed}, mesma referência=${again.providerRef === first.providerRef}); ${posts(env)} post, ${count} mensagem` };
}

async function slow(t, env) {
  await prepare(t, env);
  const { slowMarginMs } = await readDrillParams(env.tenant, t);
  await setParam(t, env, WORKER.timeout, 1);
  await setParam(t, env, SLOW_MS_KEY, MS + slowMarginMs);
  const p = await person(t, env);
  const key = newKey();
  const first = await send(t, env, p, key, { scenario: 'SLOW' });
  await new Promise((resolve) => { setTimeout(resolve, slowMarginMs + 200); }); // o canal termina o envio tardio
  const second = await send(t, env, p, key);
  const count = (await rows(t, env, key)).length;
  const ok = first.status === 'UNKNOWN' && second.status === 'SENT' && posts(env) === 1 && count === 1;
  return { ok, obtained: `resposta em ${MS + slowMarginMs} ms contra o limite de ${MS} ms: ${first.status}; mesma chave: ${second.status}; ${posts(env)} post, ${count} mensagem` };
}

/** HTTP_429: a mensagem não se perde nem sai em rajada: fica na fila (QUEUED) com UMA chamada ao canal; só um novo pedido da mesma chave a reenvia (uma mensagem, um post). */
async function http429(t, env) {
  await prepare(t, env);
  const probe = installCallCounter(env.channel);
  try {
    const p = await person(t, env);
    const key = newKey();
    const first = await send(t, env, p, key, { scenario: 'HTTP_429' });
    const callsAfterLimit = probe.counter.sends;
    const second = await send(t, env, p, key);
    const count = (await rows(t, env, key)).length;
    const ok = first.status === 'QUEUED' && callsAfterLimit === 1 && posts(env) === 1 && second.status === 'SENT' && count === 1;
    return { ok, obtained: `1ª resposta ${first.status} com ${callsAfterLimit} chamada ao canal (sem rajada); mesma chave: ${second.status}; ${posts(env)} post, ${count} mensagem` };
  } finally {
    probe.restore();
  }
}

async function rejected(t, env) {
  await prepare(t, env);
  const p = await person(t, env);
  const key = newKey();
  const first = await send(t, env, p, key, { scenario: 'REJECTED' });
  const again = await send(t, env, p, key);
  const [row] = await query(t, 'SELECT failure_reason FROM crm.messages WHERE company_id = :c AND action_key = :k', { c: env.tenant.companyId, k: key });
  const ok = first.status === 'FAILED' && again.status === 'FAILED' && again.replayed === true && posts(env) === 0 && Boolean(row && /recus/i.test(row.failure_reason || ''));
  return { ok, obtained: `${first.status}; motivo: "${row ? row.failure_reason : 'ausente'}"; reenvio da chave: ${again.status} sem nova tentativa; ${posts(env)} post` };
}

/** AUTH_REVOKED: a mensagem falha sem nova tentativa e a credencial revogada trava o canal e a conexão da família (conta comprometida, M9-D433), com alerta na auditoria. */
async function authRevoked(t, env) {
  await prepare(t, env);
  const p = await person(t, env);
  // a conexão que o envio usa, pelo id: o ensaio não depende de outras conexões do mesmo provedor que já existam na empresa (hermético)
  const used = await resolveChannelConnection({ tenant: env.tenant, actor: null, channel: env.channel, transaction: t });
  const first = await send(t, env, p, newKey(), { scenario: 'AUTH_REVOKED' });
  const blocked = await isOutboundBlocked(env.tenant, { channel: env.channel }, t);
  const [conn] = await query(t, 'SELECT status FROM integration.connections WHERE id = :id AND company_id = :c', { id: used.id, c: env.tenant.companyId });
  const [alert] = await query(t, "SELECT count(*)::int AS n FROM audit.audit_log WHERE company_id = :c AND action = 'marketing.channel.compromised'", { c: env.tenant.companyId });
  const next = await send(t, env, p, newKey()).then(() => 'saiu', (e) => e.code);
  const ok = first.status === 'FAILED' && blocked.blocked === true && Boolean(conn) && conn.status === 'COMPROMISED' && alert.n >= 1 && next === 'MKT_CHANNEL_COMPROMISED' && posts(env) === 0;
  return { ok, obtained: `${first.status}; conexão ${conn ? conn.status : 'sem conexão'}; canal travado=${blocked.blocked}; alertas=${alert.n}; novo envio: ${next}; ${posts(env)} post` };
}

/** HTTP_5XX contínuo na mensagem: o circuito abre, os envios novos são recusados (503) sem chamar o canal e sem gravar nada; a meia-abertura admite UMA chamada de teste. */
async function http5xx(t, env) {
  await prepare(t, env);
  const probe = installCallCounter(env.channel);
  try {
    const { pendingJobs } = await readDrillParams(env.tenant, t);
    await setParam(t, env, HALF_OPEN_KEY, 1);
    const ref = await resolveChannelConnection({ tenant: env.tenant, actor: null, channel: env.channel, transaction: t });
    const connection = await IntegrationConnection.findByPk(ref.id, { transaction: t });
    const hctx = { groupId: env.tenant.groupId, companyId: env.tenant.companyId, userId: null };
    const policy = await health.resolveCircuitPolicy(hctx, connection, t);
    const state = async (at) => (await health.getCurrentHealth(connection.id, hctx, t, { now: at })).circuitState;
    const p = await person(t, env);
    const t0 = new Date();
    for (let i = 0; i < policy.failure_threshold; i += 1) await send(t, env, p, newKey(), { scenario: 'HTTP_5XX', now: t0 });
    const opened = (await state(t0)) === 'OPEN';
    const callsToOpen = probe.counter.sends;
    const waiting = [];
    for (let i = 0; i < pendingJobs; i += 1) {
      const key = newKey();
      const err = await send(t, env, p, key, { now: seconds(t0, 5) }).then(() => null, (e) => e);
      waiting.push({ refused: Boolean(err && err.statusCode === 503 && err.code === 'INTEGRATION_CIRCUIT_OPEN'), saved: (await rows(t, env, key)).length });
    }
    const refused = waiting.filter((w) => w.refused).length;
    const saved = waiting.reduce((n, w) => n + w.saved, 0);
    const halfAt = seconds(t0, policy.cooldown_s + 5);
    const failedProbe = await send(t, env, p, newKey(), { scenario: 'HTTP_5XX', now: halfAt });
    const blockedAfterProbe = await send(t, env, p, newKey(), { now: halfAt }).then(() => false, (e) => e.code === 'INTEGRATION_CIRCUIT_OPEN');
    const probeCalls = probe.counter.sends - callsToOpen;
    const reopened = (await state(halfAt)) === 'OPEN';
    const closeAt = seconds(halfAt, policy.cooldown_s + 5);
    const recovered = await send(t, env, p, newKey(), { now: closeAt });
    const closed = (await state(closeAt)) === 'CLOSED';
    const ok = opened && refused === pendingJobs && saved === 0 && failedProbe.status === 'QUEUED' && blockedAfterProbe && probeCalls === 1 && reopened && recovered.status === 'SENT' && closed;
    return {
      ok,
      obtained: `circuito ${opened ? 'ABRIU' : 'NÃO abriu'} após ${policy.failure_threshold} falhas; ${refused} de ${pendingJobs} envios novos recusados (503) sem chamar o canal e ${saved} gravados; meia-abertura: ${probeCalls} chamada de teste que falhou e o circuito ${reopened ? 'reabriu' : 'NÃO reabriu'}; depois do cooldown a chamada de teste deu certo e o circuito ficou ${closed ? 'CLOSED' : 'aberto'}`,
    };
  } finally {
    probe.restore();
  }
}

module.exports = { baseline, timeout, unknownButPublished, unknownNotPublished, duplicateKey, slow, http429, rejected, authRevoked, http5xx };
