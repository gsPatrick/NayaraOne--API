'use strict';

// Apoio dos testes da M9-D628 (read models de Tecnologia, Integrações, Segurança e IA): relógio fixo (12:00 de 28/10/2026 em São Paulo), gravação dos sinais técnicos globais
// (analytics.tech_signal_log não tem empresa: entra por conexão de superusuário) e limpeza. As fontes por empresa usam `bi.seed` (biObrasJuridicoEnv). Banco descartável.
const crypto = require('node:crypto');
const bi = require('./biObrasJuridicoEnv');

const MODELS = ['rm_tech_availability', 'rm_tech_queues', 'rm_tech_freshness', 'rm_tech_integrations', 'rm_tech_blocked_events', 'rm_tech_auth_failures', 'rm_ai_cost', 'rm_ai_quality', 'rm_ai_tool_calls'];
const hash = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
const at = (iso) => new Date(iso);
const minutesBefore = (minutes) => new Date(bi.NOW.getTime() - minutes * 60000);

async function setup() {
  const env = await bi.setup(MODELS);
  await env.admin.query('DELETE FROM analytics.tech_signal_log'); // sinais de outro teste não entram nas contas deste
  return env;
}

/** Grava um sinal técnico global; `occurredAt` ISO. Registra para a limpeza. */
async function signal(env, { kind, probe = null, ok = null, actor = null, ip = null, occurredAt }) {
  const id = bi.uuid();
  await env.admin.query(
    'INSERT INTO analytics.tech_signal_log (id, kind, probe, ok, actor_hash, ip_hash, occurred_at) VALUES (:id, :kind, :probe, :ok, :actor, :ip, :at)',
    { replacements: { id, kind, probe, ok, actor: actor ? hash(actor) : null, ip: ip ? hash(ip) : null, at: occurredAt } }
  );
  env.created.push({ table: 'analytics.tech_signal_log', id });
  return id;
}

async function refresh(env, tenant, { model, status = 'SUCCEEDED', snapshotAt, finishedAt = bi.NOW }) {
  const id = bi.uuid();
  await env.admin.query(
    `INSERT INTO analytics.read_model_refreshes (id, group_id, company_id, read_model, trigger, status, source_snapshot_at, started_at, finished_at, duration_ms, error_code, error_message)
     VALUES (:id, :g, :c, :model, 'SCHEDULE', :status, :snap, :snap, :fin, 10, :code, :msg)`,
    { replacements: { id, g: tenant.groupId, c: tenant.companyId, model, status, snap: snapshotAt, fin: finishedAt, code: status === 'FAILED' ? 'X' : null, msg: status === 'FAILED' ? 'falha' : null } }
  );
  env.created.push({ table: 'analytics.read_model_refreshes', id });
  return id;
}

/** Linhas do read model da empresa SEM metadados, na ordem da chave, como texto (comparação estável entre execuções). */
async function content(env, model, tenant) {
  return (await bi.rowsOf(env, model, tenant)).map(({ company_id: _c, group_id: _g, source_snapshot_at: _s, refreshed_at: _r, version: _v, ...rest }) => (
    Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v === null ? null : String(v)]))
  ));
}

module.exports = { ...bi, MODELS, hash, at, minutesBefore, setup, signal, refresh, content };
