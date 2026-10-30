'use strict';

// Apoio dos testes M9-D425 (kill switch do Marketing) com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js).
const crypto = require('node:crypto');
const env = require('./mktMsgEnv');
const ks = require('../../../src/features/marketing/killswitch.service');
const flagsResolve = require('../../../src/features/core-governance/feature-flags/flags.resolve');
const { comTenant, carregarTenants } = require('../../integrations/dispatch/dispatchHelpers');
const { adminQuery } = require('../../m9d801.helpers');

const { q, uid } = env;

/** Aciona ou reativa um escopo pelo caminho real do serviço (parse do corpo + mudança) dentro da transação do teste. */
async function change(t, tenant, body, extra = {}) {
  const input = await ks.parseChange({ reason: 'QA-M9 teste do kill switch', ...body }, tenant, t);
  return ks.changeKillSwitch({ tenant, actorUserId: tenant.userId, input, transaction: t, ...extra });
}
const on = (t, tenant, scope, targetId, extra) => change(t, tenant, { scope, targetId, active: true }, extra);
const off = (t, tenant, scope, targetId, extra) => change(t, tenant, { scope, targetId, active: false }, extra);

/** Campanha mínima (qualquer status) para provar o escopo CAMPAIGN e a preservação dos dados. */
async function mkCampaign(t, tenant, { status = 'DRAFT', channels = ['EMAIL'] } = {}) {
  const [row] = await q(t, `INSERT INTO marketing.campaigns (id, group_id, company_id, code, name, objective, objective_metric, target_value, budget_amount, budget_justification, channels, status, owner_user_id, starts_at, ends_at)
    VALUES (gen_random_uuid(), :g, :c, :code, 'Campanha QA-M9', 'Objetivo da campanha de teste', 'LEADS', 10, 0, 'teste', CAST(:ch AS text[]), :s, :o, now() - interval '1 day', now() + interval '10 days') RETURNING id, code`,
  { g: tenant.groupId, c: tenant.companyId, code: `KS-${uid().slice(0, 8)}`, ch: `{${channels.join(',')}}`, s: status, o: tenant.userId });
  return row;
}

async function mkFlow(t, tenant) {
  const [row] = await q(t, `INSERT INTO marketing.automation_flows (id, group_id, company_id, code, name, owner_user_id) VALUES (gen_random_uuid(), :g, :c, :code, 'Fluxo QA-M9', :o) RETURNING id, code`,
    { g: tenant.groupId, c: tenant.companyId, code: `KF-${uid().slice(0, 8)}`, o: tenant.userId });
  return row;
}

const flagRow = async (t, tenant, key) => (await q(t, "SELECT id, value, version, is_kill_switch, risk, probe, state FROM governance.feature_flags WHERE company_id = :c AND key = :k AND scope = 'COMPANY'", { c: tenant.companyId, k: key }))[0];
const auditOf = (t, tenant, entityId) => q(t, "SELECT before_json, after_json, reason, user_id AS actor_user_id FROM audit.audit_log WHERE company_id = :c AND action = 'marketing.kill_switch.changed' AND entity_id = :e ORDER BY occurred_at, (before_json->>'active') ASC", { c: tenant.companyId, e: String(entityId) });
const logOf = (t, tenant, scope, targetId) => ks.listKillSwitchLog(tenant, { scope, targetId }, t);

/** Executa fn com `flags.resolve` quebrado (banco "indisponível" para o estado do kill switch) e SEMPRE restaura. */
async function withBrokenState(fn) {
  const original = flagsResolve.resolve;
  flagsResolve.resolve = async () => { throw new Error('banco indisponível (teste)'); };
  try { return await fn(); } finally { flagsResolve.resolve = original; }
}

module.exports = { ...env, ks, crypto, comTenant, carregarTenants, adminQuery, change, on, off, mkCampaign, mkFlow, flagRow, auditOf, logOf, withBrokenState };
