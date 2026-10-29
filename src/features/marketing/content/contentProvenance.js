'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { mktNayRunRequired, mktNayModelRequired } = require('../marketing.errors');
const { loadPublicProperty } = require('./publicReadModel');
const { hashFacts, sha256, canonicalJson } = require('./sourceStamp');

/**
 * M9-D405 regras 1 e 2 — todo conteúdo guarda a fonte (tipo, id, versão) e, quando gerado pela NAY, o modelo e a execução (run).
 * Escrito por pessoa: model_name e nay_run_id ficam nulos. Modelo sem run, ou run sem modelo, é recusado (422).
 */
function normalizeGeneration(generation) {
  const modelName = generation && generation.modelName ? String(generation.modelName).trim() : null;
  const nayRunId = generation && generation.nayRunId ? String(generation.nayRunId) : null;
  if (modelName && !nayRunId) throw mktNayRunRequired({ field: 'nayRunId' });
  if (nayRunId && !modelName) throw mktNayModelRequired({ field: 'modelName' });
  return { modelName, nayRunId };
}

/** Fonte de um imóvel: { entityType, entityId, version, facts } lida só do read model público sanitizado. */
async function sourceFromProperty(propertyId, tenant, transaction) {
  const model = await loadPublicProperty({ propertyId }, tenant, transaction);
  return { entityType: 'property', entityId: propertyId, version: model.sourceVersion, facts: model.payload };
}

/**
 * Cria o item e a versão 1 na mesma transação, ligando a versão corrente (a FK dela é adiada até o fim da transação). `extra`
 * (campaignId, updatesContentItemId, template, autopublishClass, triggerEventId) é opcional e repassado como veio.
 */
async function createContentWithProvenance(input, tenant, actorUserId, transaction) {
  const { type, title, source, bodyJson, generation, extra = {} } = input;
  const { modelName, nayRunId } = normalizeGeneration(generation);
  const facts = source ? source.facts : {};
  const run = (sql, replacements) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

  const [item] = await run(
    `INSERT INTO marketing.content_items (group_id, company_id, type, title, status, source_entity_type, source_entity_id, source_version,
        nay_run_id, campaign_id, updates_content_item_id, autopublish_class, trigger_event_id, created_by, updated_by)
     VALUES (:groupId, :companyId, :type, :title, 'DRAFT', :sourceType, :sourceId, :sourceVersion, :nayRunId, :campaignId, :updatesId,
        :autopublish, :triggerEventId, :actor, :actor) RETURNING *`,
    {
      groupId: tenant.groupId, companyId: tenant.companyId, type, title,
      sourceType: source ? source.entityType : null, sourceId: source ? source.entityId : null,
      sourceVersion: source && source.version !== undefined ? source.version : null,
      nayRunId, campaignId: extra.campaignId || null, updatesId: extra.updatesContentItemId || null,
      autopublish: extra.autopublishClass || null, triggerEventId: extra.triggerEventId || null, actor: actorUserId || null,
    }
  );
  const [version] = await run(
    `INSERT INTO marketing.content_versions (group_id, company_id, content_item_id, version_no, body_json, facts_snapshot_json, facts_hash,
        template_id, template_version_no, model_name, nay_run_id, content_hash, created_by, updated_by)
     VALUES (:groupId, :companyId, :itemId, 1, CAST(:body AS jsonb), CAST(:facts AS jsonb), :factsHash, :templateId, :templateVersionNo,
        :modelName, :nayRunId, :contentHash, :actor, :actor) RETURNING *`,
    {
      groupId: tenant.groupId, companyId: tenant.companyId, itemId: item.id, body: JSON.stringify(bodyJson), facts: JSON.stringify(facts),
      factsHash: source ? hashFacts(facts) : null, templateId: extra.templateId || null, templateVersionNo: extra.templateVersionNo || null,
      modelName, nayRunId, contentHash: sha256(canonicalJson({ body: bodyJson, facts })), actor: actorUserId || null,
    }
  );
  await sequelize.query('UPDATE marketing.content_items SET current_version_id = :versionId WHERE id = :itemId AND company_id = :companyId',
    { replacements: { versionId: version.id, itemId: item.id, companyId: tenant.companyId }, transaction });
  const camel = (row) => ({ ...row, status: row.status, factsHash: row.facts_hash });
  return { item: camel({ ...item, current_version_id: version.id }), version: camel(version) };
}

module.exports = { normalizeGeneration, sourceFromProperty, createContentWithProvenance };
