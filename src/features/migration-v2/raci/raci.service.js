'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { RACI } = require('./raci.constants');
const errors = require('./raci.errors');
const repo = require('./raci.repository');
const { ensureActivities } = require('./raci.seed');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Completa = exatamente um A e ao menos um R. `missing` diz o que falta. */
function completeness(entries) {
  const accountable = entries.filter((entry) => entry.raci === RACI.A).length;
  const responsible = entries.filter((entry) => entry.raci === RACI.R).length;
  const missing = [];
  if (accountable === 0) missing.push('A');
  if (responsible === 0) missing.push('R');
  return { complete: missing.length === 0 && accountable === 1, missing };
}

/** GET /migration/raci: a matriz das atividades (semeia se for o primeiro acesso da empresa). */
async function getMatrix(tenant, transaction) {
  await ensureActivities(tenant, transaction);
  const [activities, entries] = await Promise.all([repo.listActivities(tenant, transaction), repo.listEntries(tenant, transaction)]);
  return {
    activities: activities.map((activity) => {
      const own = entries.filter((entry) => entry.activityCode === activity.code).map(({ userId, role, raci }) => ({ userId, role, raci }));
      return { ...activity, entries: own, ...completeness(own) };
    }),
  };
}

function normalizeEntries(body) {
  if (!body || !Array.isArray(body.entries)) throw errors.invalid('Informe a atividade e as linhas do RACI.');
  const seen = new Set();
  return body.entries.map((raw) => {
    const raci = String(raw && raw.raci ? raw.raci : '').toUpperCase();
    if (!RACI[raci]) throw errors.invalid('O valor do RACI deve ser R, A, C ou I.', { raci: raw && raw.raci });
    const userId = raw.userId ? String(raw.userId) : null;
    const role = raw.role ? String(raw.role).trim() : null;
    if (Boolean(userId) === Boolean(role)) throw errors.invalid('Cada linha informa um usuário OU um perfil.');
    if (userId && !UUID.test(userId)) throw errors.invalid('Usuário inválido.', { userId });
    if (role && role.length > 80) throw errors.invalid('Perfil longo demais.');
    const key = `${raci}|${userId || ''}|${role ? role.toUpperCase() : ''}`;
    if (seen.has(key)) throw errors.invalid('Linha repetida no RACI.', { raci, userId, role });
    seen.add(key);
    return { userId, role, raci };
  });
}

/**
 * PUT /migration/raci: substitui a matriz de UMA atividade de forma atômica (M9-D902 §3.2). Dois "A" -> 422 GOV_RACI_SINGLE_ACCOUNTABLE e nada muda. Matriz sem A ou sem R
 * é aceita (a Torre mostra o blocker GOV_MIG_RACI_INCOMPLETE). A mudança é auditada com o antes e o depois.
 */
async function replaceActivity(tenant, actor, body, transaction) {
  await ensureActivities(tenant, transaction);
  const code = body && body.activity ? String(body.activity) : null;
  const activity = code ? await repo.getActivity(tenant, code, transaction) : null;
  if (!activity) throw errors.activityNotFound();
  const entries = normalizeEntries(body);
  if (entries.filter((entry) => entry.raci === RACI.A).length > 1) throw errors.singleAccountable({ activity: code });
  const known = await repo.existingUserIds(tenant, [...new Set(entries.map((entry) => entry.userId).filter(Boolean))], transaction);
  const unknown = entries.find((entry) => entry.userId && !known.has(entry.userId));
  if (unknown) throw errors.invalid('Usuário sem vínculo ativo nesta empresa.', { userId: unknown.userId });
  const before = (await repo.listEntries(tenant, transaction, code)).map(({ userId, role, raci }) => ({ userId, role, raci }));
  await repo.replaceEntries(tenant, code, entries, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor.userId, action: 'migration.raci.changed', entityType: 'CutoverActivity', entityId: null,
    beforeJson: { activity: code, entries: before }, afterJson: { activity: code, entries, ...completeness(entries) }, reason: `RACI da atividade ${code} alterado.`,
  }, transaction);
  return { activity: { ...activity, entries, ...completeness(entries) } };
}

module.exports = { getMatrix, replaceActivity, completeness };
