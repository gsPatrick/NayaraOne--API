'use strict';

const { getSetting } = require('../../settings/settings.service');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const settings = require('./merge.settings');
const errors = require('./merge.errors');
const repository = require('./merge.repository');
const { STATUS, KINDS, FINAL_STATUSES } = require('./merge.constants');
const { parsePagination, pageResult } = require('../api-governance/standards/pagination.helper');
const { assertDomainSteward } = require('./merge.steward');
const { parseDecision, parseListQuery, isUuid } = require('./merge.input');
const { applyMerge } = require('./merge.apply');
const { assertNoneOnHold } = require('./legalHold.guard');

const ENTITY_LABEL = { PERSON: 'Person', PROPERTY: 'Property', SUPPLIER: 'Supplier' };

const view = (row) => ({
  id: row.id, entityType: row.entity_type, kind: row.kind, primaryId: row.primary_id, secondaryId: row.secondary_id, primaryName: row.primary_name, secondaryName: row.secondary_name,
  reasonCode: row.reason_code, score: Number(row.score), status: row.status, assignedStewardId: row.assigned_steward_id, decidedBy: row.decided_by, decidedAt: row.decided_at,
  decisionNote: row.decision_note, survivorId: row.survivor_id, evidence: row.evidence, createdAt: row.created_at,
});

/** GET /data-quality/queue — a fila (abertos primeiro, maior score primeiro), com filtros status, entityType e kind e paginação. */
async function listQueue(tenant, query, transaction) {
  const size = Number(await getSetting(settings.PAGE_SIZE_KEY, tenant, transaction, settings.MERGE_SETTING_DEFAULTS[settings.PAGE_SIZE_KEY]));
  const paging = await parsePagination(query || {}, tenant, transaction, size);
  const { items, total } = await repository.listItems(tenant, parseListQuery(query, paging), transaction);
  return pageResult(items.map(view), paging, total);
}

/** A decisão é válida para o tipo do item? REVIEW só aceita DISMISSED (falso alarme); MERGED exige o sobrevivente dentro do par. */
function assertDecisionFits(item, input) {
  if (item.kind === KINDS.REVIEW && input.decision !== STATUS.DISMISSED) throw errors.decisionInvalid();
  if (input.decision === STATUS.MERGED && ![item.primary_id, item.secondary_id].includes(input.survivorId)) throw errors.survivorInvalid();
}

/**
 * POST /data-quality/queue/:id/decision (M9-D805 §3.3). Item travado FOR UPDATE: duas decisões simultâneas serializam e a segunda vê o item final
 * (409). Quem decide é owner ou steward vigente do domínio. OPEN passa por IN_REVIEW na mesma transação. MERGED trava os dois cadastros em ordem
 * de id, aplica a união (merge.apply) e tudo é desfeito se qualquer passo falhar. Nenhum score une sozinho: só esta rota une.
 */
async function decide(tenant, actor, itemId, body, transaction) {
  const input = parseDecision(body);
  if (!isUuid(itemId)) throw errors.itemNotFound();
  const item = await repository.lockItem(itemId, tenant, transaction);
  if (!item) throw errors.itemNotFound();
  await assertDomainSteward(tenant, item.entity_type, actor.userId, transaction);
  if (FINAL_STATUSES.includes(item.status)) throw errors.itemFinal();
  assertDecisionFits(item, input);
  if (item.status === STATUS.OPEN) await repository.markInReview(item.id, actor.userId, transaction);

  let applied = null;
  if (input.decision === STATUS.MERGED) {
    const rows = await repository.lockRecords(item.entity_type, [item.primary_id, item.secondary_id], transaction);
    // M9-D912: a união mexe nos dois cadastros (o absorvido deixa de existir e o sobrevivente recebe os dados dele): qualquer um sob retenção legal bloqueia (409).
    await assertNoneOnHold(item.entity_type === 'PROPERTY' ? 'PROPERTY' : 'PERSON', [item.primary_id, item.secondary_id], transaction, tenant);
    const survivor = rows.find((row) => row.id === input.survivorId);
    const other = rows.find((row) => row.id !== input.survivorId);
    if (rows.length !== 2 || !survivor || !other) throw errors.notFound();
    applied = await applyMerge(item.entity_type, survivor, other, input, { tenant, actorUserId: actor.userId, transaction });
  }
  const evidenceJson = applied ? { fieldChoices: applied.choices, changeEvidence: input.evidence || null, moved: applied.moved } : (input.evidence ? { changeEvidence: input.evidence } : null);
  const updated = await repository.updateItem(item.id, {
    status: input.decision, actorUserId: actor.userId, note: input.note, survivorId: input.decision === STATUS.MERGED ? input.survivorId : null, evidence: evidenceJson,
  }, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor.userId, action: `governance.review_queue.${input.decision.toLowerCase()}`,
    entityType: `${ENTITY_LABEL[item.entity_type]}ReviewQueueItem`, entityId: item.id, beforeJson: view(item), afterJson: { ...view(updated), referencesMoved: applied ? applied.moved : null },
    reason: `Item da fila de ${item.kind === KINDS.REVIEW ? 'revisão' : 'união de cadastros'} decidido como ${input.decision} pelo responsável do domínio.`,
  }, transaction);
  return view(updated);
}

module.exports = { listQueue, decide };
