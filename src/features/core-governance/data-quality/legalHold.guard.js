'use strict';

const logger = require('../../../utils/logger');
const { sequelize } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const repository = require('./legalHold.repository');
const derive = require('./legalHold.derive');
const errors = require('./legalHold.errors');
const personScope = require('./legalHold.personScope');
const { AUDIT, CHUNK } = require('./legalHold.constants');

const norm = (value) => String(value).toLowerCase();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A trava jurídica (M9-D912 §3.2, "legal_hold sempre prevalece"). Quem apaga, anonimiza, une ou descarta pergunta aqui, DENTRO da transação da disposição:
 *   assertNotOnHold(tipo, id, transaction[, tenant])  -> 409 GOV_HOLD_BLOCKS_DISPOSAL se o registro está sob retenção ativa
 *   heldIds(tipo, ids, { tenant?, transaction, disposal? }) -> as chaves que estão sob retenção (interface `holdGuard` da retenção, M9-D911)
 * Nenhum papel e nenhum parâmetro desliga a checagem. `disposal: true` toma a trava compartilhada da empresa: uma retenção criada ao mesmo tempo espera a disposição em curso
 * terminar (e a disposição seguinte já a enxerga); o FOR SHARE nas linhas de alvo segura a liberação até o fim da transação. Registros que passaram a cair no escopo depois da
 * criação (contrato novo da pessoa em hold) entram nos alvos aqui mesmo. Processo com a marca antiga `legal_hold` (M5-26) também vale.
 */
async function heldIds(type, ids, ctx = {}) {
  const { transaction } = ctx;
  if (!transaction) throw new Error('A checagem de retenção legal exige a transação da disposição.');
  const wanted = [...new Set((ids || []).map(norm))];
  if (!wanted.length) return [];
  const companyId = (ctx.tenant && ctx.tenant.companyId) || await repository.contextCompany(transaction);
  if (ctx.disposal) await repository.lockDisposal(companyId, transaction);
  const held = new Set();
  if (type === 'LEGAL_CASE') for (let i = 0; i < wanted.length; i += CHUNK) (await repository.markedCases(wanted.slice(i, i + CHUNK), transaction)).forEach((id) => held.add(id));
  const holds = await repository.activeHolds(companyId, transaction);
  if (holds.length) {
    for (let i = 0; i < wanted.length; i += CHUNK) {
      const part = wanted.slice(i, i + CHUNK);
      await derive.ensure(holds, type, part, transaction);
      const found = await repository.heldAmong(companyId, type, part, transaction, { lock: Boolean(ctx.disposal) });
      for (const id of part) if (found.all || found.ids.has(id)) held.add(id);
    }
  }
  return wanted.filter((id) => held.has(id));
}

const isOnHold = async (type, id, ctx) => (await heldIds(type, [id], ctx)).length > 0;

/** A recusa fica na auditoria numa transação PRÓPRIA (a da disposição será desfeita pelo erro e levaria o registro junto). */
async function auditBlock(type, blocked, transaction, tenant) {
  try {
    const companyId = (tenant && tenant.companyId) || await repository.contextCompany(transaction);
    const userId = (tenant && tenant.userId) || await repository.contextUser(transaction);
    const groupId = (tenant && tenant.groupId) || (await sequelize.query("SELECT NULLIF(current_setting('app.group_id', true), '') AS id", { type: 'SELECT', transaction }))[0].id;
    if (!companyId || !groupId) return;
    await sequelize.transaction(async (own) => {
      await sequelize.query("SELECT set_config('app.group_id', :groupId, true), set_config('app.company_id', :companyId, true)", { replacements: { groupId, companyId }, transaction: own });
      await registrarAuditoria({
        groupId, companyId, actorUserId: userId || null, action: AUDIT.BLOCKED, entityType: type, entityId: blocked.length === 1 && UUID.test(blocked[0]) ? blocked[0] : null,
        beforeJson: null, afterJson: { entityType: type, entityIds: blocked.slice(0, 20), total: blocked.length }, reason: 'Disposição recusada: o registro está sob retenção legal (legal hold).',
      }, own);
    });
  } catch (err) {
    logger.warn({ err: err.message }, '[LegalHold] Não foi possível auditar a recusa.');
  }
}

/** Recusa (409) se algum dos registros está sob retenção legal. */
async function assertNoneOnHold(type, ids, transaction, tenant) {
  const blocked = await heldIds(type, ids, { tenant, transaction, disposal: true });
  if (!blocked.length) return;
  await auditBlock(type, blocked, transaction, tenant);
  throw errors.disposalBlocked({ entityType: type, count: blocked.length });
}

const assertNotOnHold = (type, id, transaction, tenant) => assertNoneOnHold(type, [id], transaction, tenant);

/**
 * Pedido de exclusão do titular (LGPD) e exclusão manual da pessoa: recusados se a pessoa, um contrato, um processo ou um arquivo ligado a ela está sob retenção (a
 * exclusão ou anonimização da pessoa mexe nesses dados). O dado segue em hold.
 */
async function assertPersonErasable(personId, transaction, tenant) {
  await assertNotOnHold('PERSON', personId, transaction, tenant);
  const related = await personScope.relatedOf(personId, transaction);
  for (const [type, ids] of Object.entries(related)) if (ids.length) await assertNoneOnHold(type, ids, transaction, tenant);
}

module.exports = { heldIds, isOnHold, assertNotOnHold, assertNoneOnHold, assertPersonErasable };
