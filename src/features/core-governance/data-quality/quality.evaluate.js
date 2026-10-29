'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { dateKeyInZone } = require('../calendar/sources/time');
const { ensureRules, loadConfig } = require('./quality.rules');
const { loadContexts } = require('./quality.loader');
const { scoreEntity } = require('./quality.score');
const { CHECKS, APPLIES } = require('./quality.checks');
const { reconcileIssues } = require('./quality.issues');

/** Garante a linha da nota e a trava FOR UPDATE: duas avaliações do mesmo cadastro se serializam (M9-D806 §6). */
async function lockScore(tenant, entityType, entityId, transaction) {
  const replacements = { groupId: tenant.groupId, companyId: tenant.companyId, entityType, entityId };
  await sequelize.query(
    `INSERT INTO governance.quality_scores (group_id, company_id, entity_type, entity_id, score) VALUES (:groupId, :companyId, :entityType, :entityId, 0)
     ON CONFLICT (company_id, entity_type, entity_id) DO NOTHING`, { transaction, replacements }
  );
  await sequelize.query('SELECT id FROM governance.quality_scores WHERE company_id = :companyId AND entity_type = :entityType AND entity_id = :entityId FOR UPDATE', { type: QueryTypes.SELECT, transaction, replacements });
}

async function saveScore(tenant, entityType, entityId, result, transaction) {
  await sequelize.query(
    `UPDATE governance.quality_scores SET score = :score, passed_weight = :passedWeight, applicable_weight = :applicableWeight, calculated_at = now(), updated_at = now()
      WHERE company_id = :companyId AND entity_type = :entityType AND entity_id = :entityId`,
    { transaction, replacements: { companyId: tenant.companyId, entityType, entityId, score: result.score, passedWeight: result.passedWeight, applicableWeight: result.applicableWeight } }
  );
}

/**
 * Avalia vários cadastros da mesma entidade na transação do chamador (M9-D806 §3.2 e 3.3): calcula a nota pelas regras vigentes, grava e reconcilia as
 * issues (eventos, auditoria, fila de revisão). Cadastro apagado, unido ou que não é do tipo (pessoa sem papel de fornecedor) é ignorado.
 * Tudo na mesma transação: se algo falhar, nota, issues e eventos voltam juntos.
 */
async function evaluateEntities(tenant, entityType, ids, transaction, { actorUserId = null, now = new Date() } = {}) {
  const rules = (await ensureRules(tenant, transaction)).filter((rule) => rule.entity_type === entityType);
  const active = rules.filter((rule) => rule.active);
  const cfg = await loadConfig(tenant, transaction, dateKeyInZone(now));
  const contexts = await loadContexts(tenant, entityType, ids, transaction);
  const results = [];
  for (const entityId of ids) {
    const ctx = contexts.get(entityId);
    if (!ctx) continue;
    await lockScore(tenant, entityType, entityId, transaction);
    const scored = scoreEntity(active, ctx, cfg, { checks: CHECKS, applies: APPLIES });
    await saveScore(tenant, entityType, entityId, scored, transaction);
    const { opened, resolved } = await reconcileIssues(tenant, entityType, entityId, scored.failed, { actorUserId }, transaction);
    results.push({
      entityType, entityId, score: scored.score, passedWeight: scored.passedWeight, applicableWeight: scored.applicableWeight, failed: scored.failed.map((rule) => rule.code), opened, resolved,
    });
  }
  return results;
}

/** Avalia um cadastro; null se ele não existe na empresa (ou não é desse tipo). */
async function evaluateEntity(tenant, entityType, entityId, transaction, options = {}) {
  const [result] = await evaluateEntities(tenant, entityType, [entityId], transaction, options);
  return result || null;
}

module.exports = { evaluateEntity, evaluateEntities };
