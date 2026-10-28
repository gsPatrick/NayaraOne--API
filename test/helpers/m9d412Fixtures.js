'use strict';

// M9-D412 — fábricas dos testes de campanha. Tudo roda em transação com rollback (RLS real, role de runtime).

const crypto = require('node:crypto');
const { QueryTypes } = require('sequelize');
const { sequelize, Group, Company } = require('../../src/models');
const { getSeedTenant } = require('../testHelpers');

const uid = () => crypto.randomUUID();
const q = (t, sql, replacements) => sequelize.query(sql, { transaction: t, replacements, type: QueryTypes.SELECT });
const DAY = 24 * 3600 * 1000;

async function tenants() {
  const a = await getSeedTenant();
  const groupB = await Group.findOne({ where: { name: 'CI — Grupo Fictício A' } });
  if (!groupB) throw new Error('o seed de dois tenants precisa ter rodado (scripts/seed-ci-two-tenants.js)');
  const companyB = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: groupB.id }, transaction });
    return Company.findOne({ where: { groupId: groupB.id }, transaction });
  });
  return { a, b: { groupId: groupB.id, companyId: companyB.id, userId: a.userId } };
}

/** Executa fn no contexto da outra empresa dentro da mesma transação e volta ao contexto original. */
async function asTenant(t, from, other, fn) {
  const set = async (x) => {
    await sequelize.query('SELECT set_config(\'app.group_id\', :g, true), set_config(\'app.company_id\', :c, true)',
      { transaction: t, replacements: { g: x.groupId, c: x.companyId } });
  };
  await set(other);
  try { return await fn(); } finally { await set(from); }
}

async function makePerson(t, tenant, { status = 'ACTIVE', roles = [], type = 'PF', name = 'QA-M9 Pessoa D412' } = {}) {
  const [row] = await q(t, `INSERT INTO people.persons (id, group_id, company_id, person_type, legal_name, status)
    VALUES (gen_random_uuid(), :g, :c, :ty, :n, :s) RETURNING id`, { g: tenant.groupId, c: tenant.companyId, ty: type, n: name, s: status });
  for (const role of roles) {
    await q(t, `INSERT INTO people.person_roles (id, group_id, company_id, person_id, role_code) VALUES (gen_random_uuid(), :g, :c, :p, :r) RETURNING id`,
      { g: tenant.groupId, c: tenant.companyId, p: row.id, r: role });
  }
  return row.id;
}

async function makeOpportunity(t, tenant, personId, { stage = 'NEW', temperature = null } = {}) {
  const [row] = await q(t, `INSERT INTO crm.opportunities (id, group_id, company_id, person_id, stage, temperature)
    VALUES (gen_random_uuid(), :g, :c, :p, :s, :tp) RETURNING id`, { g: tenant.groupId, c: tenant.companyId, p: personId, s: stage, tp: temperature });
  return row.id;
}

async function makeRadar(t, tenant, personId, criteria = {}, status = 'ACTIVE') {
  const [row] = await q(t, `INSERT INTO crm.property_radars (id, group_id, company_id, person_id, criteria_json, status)
    VALUES (gen_random_uuid(), :g, :c, :p, CAST(:cr AS jsonb), :s) RETURNING id`,
  { g: tenant.groupId, c: tenant.companyId, p: personId, cr: JSON.stringify(criteria), s: status });
  return row.id;
}

async function makeTemplate(t, tenant, { channel = 'EMAIL', status = 'PUBLISHED' } = {}) {
  const [row] = await q(t, `INSERT INTO marketing.templates (id, group_id, company_id, code, version_no, kind, channel, status, body, content_hash)
    VALUES (gen_random_uuid(), :g, :c, :code, 1, 'MESSAGE', :ch, :s, 'Olá', :h) RETURNING id`,
  { g: tenant.groupId, c: tenant.companyId, code: `qa-m9-${uid().slice(0, 8)}`, ch: channel, s: status, h: crypto.createHash('sha256').update(uid()).digest('hex') });
  return row.id;
}

/** Corpo completo e válido de uma campanha para agendar (público = lista de pessoas informada). */
function completeBody({ templateId, personIds, channel = 'EMAIL', startsInDays = 3, durationDays = 27, ...over }) {
  const now = Date.now();
  return {
    code: `QA-M9-${uid().slice(0, 8)}`,
    name: 'Lançamento Aurora',
    objective: 'Gerar 40 visitas agendadas para o lançamento Aurora',
    objectiveMetric: 'VISITS',
    targetValue: 40,
    budgetAmount: 12000,
    channels: [channel],
    startsAt: new Date(now + startsInDays * DAY).toISOString(),
    endsAt: new Date(now + (startsInDays + durationDays) * DAY).toISOString(),
    audiences: [{ kind: 'PERSON_LIST', purpose: 'LANCAMENTO', filter: { personIds } }],
    steps: [{ channel, templateId, offsetMinutes: 0 }],
    ...over,
  };
}

const loadCampaign = async (t, id) => (await q(t, 'SELECT * FROM marketing.campaigns WHERE id = :id', { id }))[0];
const loadSteps = (t, id) => q(t, 'SELECT * FROM marketing.campaign_steps WHERE campaign_id = :id AND deleted_at IS NULL ORDER BY step_no', { id });

/** Coloca a campanha numa janela que já começou/terminou (o CHECK só exige fim > início). */
const moveWindow = (t, id, startsAt, endsAt) =>
  q(t, 'UPDATE marketing.campaigns SET starts_at = :s, ends_at = :e WHERE id = :id RETURNING id', { id, s: startsAt, e: endsAt });

const rejectsWith = async (assert, promise, status, code) => assert.rejects(promise, (e) => {
  assert.equal(e.statusCode, status, `status ${e.statusCode} / ${e.code}`);
  assert.equal(e.code, code);
  assert.ok(/[a-zà-ú]/i.test(e.message));
  return true;
});

module.exports = {
  uid, q, DAY, tenants, asTenant, makePerson, makeOpportunity, makeRadar, makeTemplate, completeBody, loadCampaign, loadSteps, moveWindow, rejectsWith,
};
