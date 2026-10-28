'use strict';

// M9-D401 — apoio comum dos testes do schema marketing parte 2: tenants, consulta, fábricas e população mínima.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { QueryTypes } = require('sequelize');

const { sequelize, Group, Company } = require('../../src/models');
const { getSeedTenant } = require('../testHelpers');

const TABLES = [
  'publication_jobs', 'publication_results', 'automation_flows', 'automation_versions', 'automation_runs',
  'suppression_list', 'tracking_links', 'attribution_events', 'review_requests',
];
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const uid = () => crypto.randomUUID();

async function q(sql, replacements, transaction) {
  return sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });
}

async function expectDbError(transaction, sql, replacements, matcher) {
  await sequelize.query('SAVEPOINT s1', { transaction });
  let err = null;
  try {
    await sequelize.query(sql, { replacements, transaction });
  } catch (e) {
    err = e;
  }
  await sequelize.query('ROLLBACK TO SAVEPOINT s1', { transaction });
  assert.ok(err, 'o banco deveria ter recusado o comando');
  if (matcher) assert.match(`${err.parent?.constraint || ''} ${err.parent?.message || err.message}`, matcher);
  return err;
}

const base = (t) => ({ g: t.groupId, c: t.companyId });

// ---------- fábricas (cada uma devolve o id) ----------
async function mkTemplate(t, tx) {
  const [r] = await q(`INSERT INTO marketing.templates (group_id, company_id, code, version_no, kind, channel, status, body, content_hash)
    VALUES (:g, :c, :code, 1, 'CONTENT', 'SITE', 'DRAFT', 'x', :h) RETURNING id`, { ...base(t), code: `T-${uid().slice(0, 6)}`, h: sha('t') }, tx);
  return r.id;
}
async function mkVersion(t, tx) {
  const tpl = await mkTemplate(t, tx);
  const [item] = await q(`INSERT INTO marketing.content_items (group_id, company_id, type, title) VALUES (:g, :c, 'NEW_PROPERTY', 'QA-M9') RETURNING id`, base(t), tx);
  const [v] = await q(`INSERT INTO marketing.content_versions (group_id, company_id, content_item_id, version_no, body_json, template_id, template_version_no, content_hash)
    VALUES (:g, :c, :i, 1, '{}'::jsonb, :t, 1, :h) RETURNING id`, { ...base(t), i: item.id, t: tpl, h: sha('v') }, tx);
  return { versionId: v.id, itemId: item.id };
}
async function mkJob(t, tx, over = {}) {
  const { versionId } = over.versionId ? over : await mkVersion(t, tx);
  const key = over.key || `pub:${versionId}:SITE:2026-11-01T12:00:00.000Z`;
  const [r] = await q(`INSERT INTO marketing.publication_jobs (group_id, company_id, content_version_id, channel, adapter_code, status, idempotency_key, scheduled_at)
    VALUES (:g, :c, :v, 'SITE', 'site-cms', 'PENDING', :k, '2026-11-01T12:00:00Z') RETURNING id`, { ...base(t), v: versionId, k: key }, tx);
  return r.id;
}
async function mkFlow(t, tx) {
  const [r] = await q(`INSERT INTO marketing.automation_flows (group_id, company_id, code, name, owner_user_id, risk_level, status)
    VALUES (:g, :c, :code, 'Fluxo QA-M9', :o, 'LOW', 'ACTIVE') RETURNING id`, { ...base(t), code: `F-${uid().slice(0, 6)}`, o: t.userId }, tx);
  return r.id;
}
async function mkAutoVersion(t, tx, flowId, status = 'DRAFT', no = 1) {
  const [r] = await q(`INSERT INTO marketing.automation_versions (group_id, company_id, flow_id, version_no, trigger_type, trigger_config, conditions, actions,
      cooldown, frequency_cap, status, risk_level, content_hash)
    VALUES (:g, :c, :f, :n, 'EVENT', '{"event":"lead.created"}'::jsonb, '[]'::jsonb, '[{"action_key":"a1","type":"SEND"}]'::jsonb,
      '{}'::jsonb, '{}'::jsonb, :s, 'LOW', :h) RETURNING id`, { ...base(t), f: flowId, n: no, s: status, h: sha('av') }, tx);
  return r.id;
}
async function mkRun(t, tx, versionId, over = {}) {
  const [r] = await q(`INSERT INTO marketing.automation_runs (group_id, company_id, automation_version_id, trigger_event_id, subject_type, subject_id,
      correlation_id, idempotency_key, status, next_due_at, actions_result)
    VALUES (:g, :c, :v, 'evt-1', 'PERSON', :sid, :cid, :k, :st, :due, CAST(:ar AS jsonb)) RETURNING id`,
  { ...base(t), v: versionId, sid: uid(), cid: uid(), k: over.key || `run:${uid()}`, st: over.status || 'STARTED', due: over.due || null,
    ar: JSON.stringify(over.actionsResult || []) }, tx);
  return r.id;
}

async function popular(t, tx) {
  const jobId = await mkJob(t, tx);
  await q(`INSERT INTO marketing.publication_results (group_id, company_id, job_id, attempt_no, outcome, occurred_at) VALUES (:g, :c, :j, 1, 'SUCCESS', now())`, { ...base(t), j: jobId }, tx);
  const flowId = await mkFlow(t, tx);
  const verId = await mkAutoVersion(t, tx, flowId);
  await mkRun(t, tx, verId);
  await q(`INSERT INTO marketing.suppression_list (group_id, company_id, address_hash, channel, reason, source, active) VALUES (:g, :c, :h, 'EMAIL', 'OPT_OUT', 'QA-M9', true)`, { ...base(t), h: sha(uid()) }, tx);
  await q(`INSERT INTO marketing.tracking_links (group_id, company_id, short_code, target_url, channel, signature, status)
    VALUES (:g, :c, :s, 'https://exemplo.test/imovel', 'SITE', :sig, 'ACTIVE')`, { ...base(t), s: uid().slice(0, 10), sig: sha('sig') }, tx);
  await q(`INSERT INTO marketing.attribution_events (group_id, company_id, event_type, touch_roles, evidence_json, valid, occurred_at)
    VALUES (:g, :c, 'CLICK', '{FIRST,LAST}', '{"ip_hash":"x"}'::jsonb, true, now())`, base(t), tx);
  const [p] = await q('SELECT id FROM people.persons LIMIT 1', {}, tx);
  if (p) {
    await q(`INSERT INTO marketing.review_requests (group_id, company_id, person_id, source_entity_type, source_entity_id, status, channel)
      VALUES (:g, :c, :p, 'CONTRACT', :s, 'PENDING', 'EMAIL')`, { ...base(t), p: p.id, s: uid() }, tx);
  }
  return { hasPerson: !!p };
}
async function prepararTenants() {
  const tenantA = await getSeedTenant();
  const groupB = await Group.findOne({ where: { name: 'CI — Grupo Fictício A' } });
  assert.ok(groupB, 'o seed de dois tenants precisa ter rodado (scripts/seed-ci-two-tenants.js)');
  const companyB = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: groupB.id }, transaction });
    return Company.findOne({ where: { groupId: groupB.id }, transaction });
  });
  assert.ok(companyB);
  return { tenantA, tenantB: { groupId: groupB.id, companyId: companyB.id, userId: tenantA.userId } };
}

module.exports = {
  TABLES, sha, uid, q, expectDbError, base, prepararTenants,
  mkTemplate, mkVersion, mkJob, mkFlow, mkAutoVersion, mkRun, popular,
};
