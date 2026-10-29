'use strict';

const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { govNotFound } = require('../../governance.errors');
const { pageResult } = require('../standards/pagination.helper');
const E = require('./consumers.errors');
const repository = require('./deprecations.repository');
const consumers = require('./consumers.repository');
const { parseTarget } = require('./target');
const { parseMoment, daysToSunset } = require('./days');
const { clearContextCache } = require('./context');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = Object.freeze(['ANNOUNCED', 'SUNSET', 'CANCELLED']);
const present = (value) => value !== undefined && value !== null && String(value).trim() !== '';

function checkReplacement(body) {
  const replacement = present(body.replacement) ? String(body.replacement).trim() : null;
  if (replacement !== null && (!replacement.startsWith('/') || replacement.length > 300 || /\s/.test(replacement))) throw E.replacementInvalid();
  const note = present(body.replacementNote) ? String(body.replacementNote).trim() : null;
  return { replacement, replacementNote: note };
}

const view = (row, now = new Date()) => ({ ...row, daysToSunset: row.status === 'CANCELLED' ? null : daysToSunset(row.sunsetAt, now) });

/**
 * Anuncia a deprecação de uma rota ou major (M9-D841 §3.2). Sem responsável: 422 GOV_API_OWNER_REQUIRED; sem desligamento: 422 GOV_API_SUNSET_REQUIRED; desligamento que não é
 * posterior ao anúncio: 422 GOV_API_DEPRECATION_INVALID. O anúncio é a data informada ou agora. Uma só deprecação em andamento por alvo (409). Auditada, na transação.
 */
async function createDeprecation({ tenant, actorUserId, body = {}, transaction }) {
  if (!present(body.ownerUserId)) throw E.ownerRequired();
  if (!present(body.sunsetAt)) throw E.sunsetRequired();
  const target = parseTarget(body.target);
  if (!target) throw E.targetInvalid();
  const announcedAt = present(body.announcedAt) ? parseMoment(body.announcedAt) : new Date();
  if (!announcedAt) throw E.dateInvalid('announcedAt');
  const sunsetAt = parseMoment(body.sunsetAt, { endOfDay: true });
  if (!sunsetAt) throw E.dateInvalid('sunsetAt');
  if (sunsetAt.getTime() <= announcedAt.getTime()) throw E.deprecationInvalid();
  if (typeof body.ownerUserId !== 'string' || !UUID.test(body.ownerUserId) || !(await consumers.isActiveMember(tenant.companyId, body.ownerUserId, transaction))) throw E.ownerInvalid();
  const { replacement, replacementNote } = checkReplacement(body);

  const row = await repository.insertDeprecation({
    groupId: tenant.groupId, companyId: tenant.companyId, target: target.key, announcedAt, sunsetAt, ownerUserId: body.ownerUserId, replacement, replacementNote, createdBy: actorUserId,
  }, transaction);
  if (!row) throw E.deprecationExists();
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: 'api.deprecation.announced', entityType: 'ApiDeprecation', entityId: row.id,
    beforeJson: null, afterJson: { target: row.target, announcedAt: row.announcedAt, sunsetAt: row.sunsetAt, ownerUserId: row.ownerUserId, replacement: row.replacement, status: row.status },
    reason: `Deprecação de ${row.target} anunciada, com desligamento em ${new Date(row.sunsetAt).toISOString()}.`,
  }, transaction);
  clearContextCache(tenant.companyId);
  return view(row);
}

/** Cancela uma deprecação anunciada (409 GOV_API_DEPRECATION_FINAL se já desligada ou cancelada). */
async function cancelDeprecation({ tenant, actorUserId, id, transaction }) {
  const current = UUID.test(String(id)) ? await repository.lockById(tenant.companyId, id, transaction) : null;
  if (!current) throw govNotFound('Deprecação não encontrada.');
  if (current.status !== 'ANNOUNCED') throw E.deprecationFinal();
  const row = await repository.setStatus(tenant.companyId, id, 'CANCELLED', transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: 'api.deprecation.cancelled', entityType: 'ApiDeprecation', entityId: id,
    beforeJson: { status: current.status }, afterJson: { status: row.status }, reason: `Deprecação de ${current.target} cancelada.`,
  }, transaction);
  clearContextCache(tenant.companyId);
  return view(row);
}

async function listDeprecations({ tenant, query = {}, paging, transaction }) {
  if (query.status !== undefined && !STATUSES.includes(query.status)) throw E.filterInvalid('status', STATUSES);
  const { items, total } = await repository.list({ companyId: tenant.companyId, status: query.status || null, limit: paging.limit, offset: paging.offset }, transaction);
  const now = new Date();
  return pageResult(items.map((row) => view(row, now)), paging, total);
}

module.exports = { createDeprecation, cancelDeprecation, listDeprecations, STATUSES };
