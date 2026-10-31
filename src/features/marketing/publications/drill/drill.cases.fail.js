'use strict';

const { scheduledJobs, setParam, jobRow, resultRows } = require('./drill.fixture');
const { prepare, cycle, posts, settle, seconds } = require('./drill.cycle');
const { query } = require('./drill.env');
const { resolveChannelConnection } = require('../schedule/schedule.connection');
const { RETRY_AFTER_KEY } = require('../adapters/channel.settings');
const { isOutboundBlocked } = require('../../killswitch.state');

/**
 * M9-D442 — falhas conhecidas do provedor (HTTP_429, REJECTED, AUTH_REVOKED). Cada uma devolve { ok, obtained }.
 */
const attemptsOf = async (t, jobId) => (await resultRows(t, jobId)).filter((r) => r.outcome !== 'METRICS').length;

/** HTTP_429: a nova tentativa espera o MAIOR entre o Retry-After do canal e o backoff; um ciclo logo depois não envia nada (sem rajada). */
async function http429(t, env) {
  await prepare(t, env);
  const retryAfterS = 120; // maior que o 1º backoff do padrão (60 s): prova que o Retry-After vale
  await setParam(t, env, RETRY_AFTER_KEY, retryAfterS);
  const s = await scheduledJobs(t, env, env.channel, 1);
  const jobId = s.jobs[0];
  await cycle(t, env, { now: s.now, scenarios: ['HTTP_429'] });
  const first = await jobRow(t, jobId);
  const waitS = first.next_attempt_at ? Math.round((new Date(first.next_attempt_at).getTime() - s.now.getTime()) / 1000) : null;
  await cycle(t, env, { now: seconds(s.now, 5) });
  const burst = await jobRow(t, jobId);
  const done = await settle(t, env, jobId, { now: s.now, step: retryAfterS + 1 });
  const ok = first.status === 'PENDING' && waitS !== null && waitS >= retryAfterS && burst.attempts === first.attempts && posts(env) === 1 && done.job.status === 'PUBLISHED' && done.job.attempts === 2;
  return { ok, obtained: `1ª tentativa ${first.status} (${first.last_error_code}); espera ${waitS} s (Retry-After ${retryAfterS} s); ciclo 5 s depois: ${burst.attempts} tentativa(s), sem rajada; no vencimento: ${done.job.status} com ${done.job.attempts} tentativas e ${posts(env)} post` };
}

/** REJECTED: falha definitiva, com motivo em português na auditoria, sem nova tentativa em nenhum ciclo seguinte. */
async function rejected(t, env) {
  await prepare(t, env);
  const s = await scheduledJobs(t, env, env.channel, 1);
  const jobId = s.jobs[0];
  await cycle(t, env, { now: s.now, scenarios: ['REJECTED'] });
  const first = await jobRow(t, jobId);
  const [audit] = await query(t, "SELECT reason FROM audit.audit_log WHERE entity_id = :id AND action = 'marketing.publication.failed' ORDER BY occurred_at DESC, id DESC LIMIT 1", { id: jobId });
  await cycle(t, env, { now: seconds(s.now, 3600) });
  const later = await jobRow(t, jobId);
  const ok = first.status === 'FAILED' && first.last_error_code === 'MKT_PROVIDER_REJECTED' && Boolean(audit && /recus/i.test(audit.reason)) && later.attempts === 1 && posts(env) === 0 && (await attemptsOf(t, jobId)) === 1;
  return { ok, obtained: `${first.status} ${first.last_error_code}; motivo: "${audit ? audit.reason : 'ausente'}"; uma hora depois: ${later.attempts} tentativa(s), ${posts(env)} post(s)` };
}

/**
 * AUTH_REVOKED: job FAILED por credencial (MKT_PROVIDER_AUTH_FAILED), nenhuma nova tentativa, e a credencial revogada pelo provedor bloqueia a conexão da família até haver nova credencial
 * (estado COMPROMISED da M9-D433, que é a "reautenticação exigida" do livro), trava o canal (kill switch com origem COMPROMISED_ACCOUNT) e deixa o alerta na auditoria.
 */
async function authRevoked(t, env) {
  await prepare(t, env);
  const s = await scheduledJobs(t, env, env.channel, 1);
  const jobId = s.jobs[0];
  // a conexão que o envio usa, pelo id: o ensaio não depende de outras conexões do mesmo provedor que já existam na empresa (hermético)
  const used = await resolveChannelConnection({ tenant: env.tenant, actor: null, channel: env.channel, transaction: t });
  await cycle(t, env, { now: s.now, scenarios: ['AUTH_REVOKED'] });
  const first = await jobRow(t, jobId);
  await cycle(t, env, { now: seconds(s.now, 3600) });
  const later = await jobRow(t, jobId);
  const [conn] = await query(t, 'SELECT status FROM integration.connections WHERE id = :id AND company_id = :c', { id: used.id, c: env.tenant.companyId });
  const blocked = await isOutboundBlocked(env.tenant, { channel: env.channel }, t);
  const [alert] = await query(t, "SELECT count(*)::int AS n FROM audit.audit_log WHERE company_id = :c AND action = 'marketing.channel.compromised'", { c: env.tenant.companyId });
  const ok = first.status === 'FAILED' && first.last_error_code === 'MKT_PROVIDER_AUTH_FAILED' && later.attempts === 1 && posts(env) === 0 && conn && conn.status === 'COMPROMISED' && blocked.blocked === true && alert.n >= 1;
  return { ok, obtained: `${first.status} ${first.last_error_code}; conexão ${conn ? conn.status : 'sem conexão'}; canal travado=${blocked.blocked}; alertas na auditoria=${alert.n}; uma hora depois: ${later.attempts} tentativa(s), ${posts(env)} post(s)` };
}

module.exports = { http429, rejected, authRevoked };
