'use strict';

const { getSetting } = require('../../settings/settings.service');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const dlpSettings = require('../dlp/dlp.settings');
const { parsePagination } = require('../api-governance/standards/pagination.helper');
const policyService = require('./retention.policy.service');
const repository = require('./classification.repository');
const { ensureRegistry, buildRows, policyResolver, readLists } = require('./classification.seed');
const inventory = require('./classification.inventory');
const { parse } = require('./classification.input');
const settings = require('./classification.settings');
const errors = require('./classification.errors');
const scale = require('../../../shared/data-classification/scale');
const { TECHNICAL_COLUMNS, DEFAULT_MASKING, CLASSES } = require('./classification.constants');

const AUDIT_ACTION = 'governance.classification.changed';
const FINDING_ACTION = 'governance.classification.coverage_finding';
const reported = new Map(); // coluna sem linha já avisada (empresa + coluna), para o aviso não inundar a auditoria
const FINDING_TTL_MS = 3600 * 1000;

const read = (tenant, tx, key) => getSetting(key, tenant, tx, settings.CLASSIFICATION_SETTING_DEFAULTS[key]);

async function listRegistry(tenant, query, transaction) {
  await ensureRegistry(tenant, transaction);
  const classification = query.classification === undefined ? null : String(query.classification).toUpperCase();
  if (classification && !CLASSES.includes(classification)) throw errors.validation('Classificação inválida.', { field: 'classification', allowed: CLASSES });
  const page = await parsePagination(query, tenant, transaction, await read(tenant, transaction, settings.PAGE_KEY));
  const { rows, total } = await repository.list(tenant, { schema: query.schema || null, table: query.table || null, classification }, page, transaction);
  return { items: rows, page: page.page, pageSize: page.pageSize, total };
}

async function listLegacyReview(tenant, query, transaction) {
  const page = await parsePagination(query, tenant, transaction, await read(tenant, transaction, settings.PAGE_KEY));
  const { rows, total } = await repository.reviewItems(tenant, page, transaction);
  return { items: rows, page: page.page, pageSize: page.pageSize, total };
}

const sameContent = (a, b) => ['classification', 'purpose', 'retentionPolicyId', 'masking', 'maskPattern', 'exportability', 'aiAllowed', 'ownerDomain'].every((key) => (a[key] ?? null) === (b[key] ?? null));

/**
 * PUT /data-classification: o steward ajusta (ou cadastra) a classificação de UMA coluna. Coluna que não existe no banco é 404 GOV_NOT_FOUND; política de retenção ausente
 * ou desconhecida é 422 GOV_CLASS_RETENTION_REQUIRED. PUT igual não altera nada (nem a versão); a alteração audita antes e depois.
 */
async function putEntry(tenant, actor, body, transaction) {
  const { target, changes } = parse(body);
  await ensureRegistry(tenant, transaction);
  const policies = await policyService.ensurePolicies(tenant, transaction);
  if (changes.policyId && !policies.some((policy) => policy.id === changes.policyId)) throw errors.retentionRequired();
  const existing = await repository.find(tenant, target, transaction, { forUpdate: true });
  if (!existing && !(await repository.columnExists(target.schema, target.table, target.column, transaction))) throw errors.columnNotFound();
  const base = existing || await (async () => {
    const data = { columns: { [`${target.schema}.${target.table}`]: [target.column] }, overrides: {} };
    const row = buildRows(data, await readLists(tenant, transaction), policyResolver(policies))[0];
    return { ...target, entity: target.table, classification: row.classification, purpose: row.purpose, retentionPolicyId: row.policy_id, masking: row.masking, maskPattern: row.mask_pattern, exportability: row.exportability, aiAllowed: row.ai_allowed, ownerDomain: row.owner_domain };
  })();
  const merged = { ...base, ...Object.fromEntries(Object.entries({ ...changes, retentionPolicyId: changes.policyId }).filter(([, v]) => v !== undefined)) };
  if (existing && sameContent(existing, merged)) return { entry: existing, changed: false };
  const entry = { ...target, entity: base.entity, classification: merged.classification, purpose: merged.purpose, policyId: merged.retentionPolicyId, masking: merged.masking, maskPattern: merged.maskPattern ?? null, exportability: merged.exportability, aiAllowed: merged.aiAllowed, ownerDomain: merged.ownerDomain };
  const saved = existing ? await repository.update(tenant, entry, actor.userId, transaction) : await repository.insertOne(tenant, entry, actor.userId, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor.userId, action: AUDIT_ACTION, entityType: 'DataClassification', entityId: saved.id,
    beforeJson: existing, afterJson: saved, reason: `Classificação de ${target.schema}.${target.table}.${target.column} ${existing ? 'alterada' : 'cadastrada'}.`,
  }, transaction);
  return { entry: saved, changed: true };
}

/** Classe padrão para coluna sem linha: governanca.dlp.classificacao_padrao (HIGH), máscara PARTIAL (M9-D910 §3.2.7, dona desta regra). */
async function defaultClass(tenant, transaction) {
  const value = await getSetting(dlpSettings.DEFAULT_CLASS_KEY, tenant, transaction, dlpSettings.DLP_SETTING_DEFAULTS[dlpSettings.DEFAULT_CLASS_KEY]);
  return dlpSettings.parseDefaultClass(value);
}

/** Aviso de cobertura (uma vez por hora e coluna): a coluna não tem linha no registro. */
async function reportCoverageFinding(tenant, ref, transaction) {
  const key = `${tenant.companyId}:${ref}`;
  if (reported.has(key) && Date.now() - reported.get(key) < FINDING_TTL_MS) return;
  reported.set(key, Date.now());
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: tenant.userId || null, action: FINDING_ACTION, entityType: 'DataClassification', entityId: null,
    beforeJson: null, afterJson: { column: ref, resolvedAs: 'DEFAULT' }, reason: `Coluna ${ref} sem classificação no registro: vale a classe padrão (GOV_CLASSIFICATION_MISSING).`,
  }, transaction);
}

/** Resolve UMA coluna: a linha do registro ou a classe padrão (HIGH) com máscara PARTIAL e um finding de cobertura. Coluna técnica (id, created_at...) é LOW sem máscara. */
async function resolveColumn(tenant, schema, table, column, transaction) {
  if (TECHNICAL_COLUMNS.includes(column)) return { classification: 'LOW', masking: 'NONE', maskPattern: null, exportability: 'ALLOWED', aiAllowed: true, isDefault: false, isTechnical: true, finding: null };
  const row = await repository.find(tenant, { schema, table, column }, transaction);
  if (row) return { ...row, isDefault: false, isTechnical: false, finding: null };
  const ref = `${schema}.${table}.${column}`;
  await reportCoverageFinding(tenant, ref, transaction);
  return { classification: await defaultClass(tenant, transaction), masking: DEFAULT_MASKING, maskPattern: null, exportability: 'ALLOWED_MASKED', aiAllowed: false, isDefault: true, isTechnical: false, finding: { code: 'GOV_CLASSIFICATION_MISSING', column: ref } };
}

/** Interface maskSpecFor (D911 e D915): { masking, maskPattern } da coluna. */
async function maskSpecFor(tenant, schema, table, column, transaction) {
  const resolved = await resolveColumn(tenant, schema, table, column, transaction);
  return { masking: resolved.masking, maskPattern: resolved.maskPattern };
}

/** Resolvedores por REGISTRO (M9-D920): um tipo de recurso cuja classe está gravada no próprio registro (ex.: `files.file` e a coluna people.files.classification) responde pelo `id` pedido. */
const recordResolvers = new Map();
const registerRecordResolver = (type, resolver) => { recordResolvers.set(type, resolver); };

/** Classe de UM recurso do DLP: o resolvedor por registro do tipo (quando há e o pedido traz `id`), `schema.tabela` (a mais alta das colunas da tabela) ou `schema.tabela.coluna`; qualquer outro tipo de recurso não está no registro e recebe a classe padrão. */
async function classOfResource(tenant, resource, transaction) {
  const byRecord = resource && resource.id ? recordResolvers.get(resource.type) : null;
  if (byRecord) {
    const found = await byRecord(tenant, resource.id, transaction);
    if (found) return found;
  }
  const parts = String((resource && resource.type) || '').split('.');
  if (parts.length < 2 || parts.length > 3 || !parts.every((part) => /^[a-z_][a-z0-9_]*$/.test(part))) return defaultClass(tenant, transaction);
  const [schema, table, column] = parts;
  if (column) return (await resolveColumn(tenant, schema, table, column, transaction)).classification;
  const rows = await repository.ofTables(tenant, [`${schema}.${table}`], transaction);
  return rows.length ? scale.highest(rows.map((row) => row.classification)) : defaultClass(tenant, transaction);
}

/** Resolvedor do guard de DLP (M9-D821): uma classe por recurso pedido, lida do registro. */
async function resolveResources(tenant, resources, transaction) {
  const list = resources && resources.length ? resources : [null];
  const out = [];
  for (const resource of list) out.push(await classOfResource(tenant, resource, transaction)); // eslint-disable-line no-await-in-loop
  return out;
}

/** Cobertura do registro da empresa contra o inventário: colunas do inventário sem linha. */
async function coverageOf(tenant, transaction, data = inventory.read()) {
  await ensureRegistry(tenant, transaction, data);
  const { rows } = await repository.list(tenant, {}, { limit: 100000, offset: 0 }, transaction);
  const have = new Set(rows.map((row) => `${row.schema}.${row.table}.${row.column}`));
  const missing = inventory.flatten(data.columns).filter((key) => !have.has(key));
  return { total: inventory.flatten(data.columns).length, registered: rows.length, missing };
}

module.exports = { listRegistry, listLegacyReview, putEntry, resolveColumn, maskSpecFor, resolveResources, classOfResource, registerRecordResolver, defaultClass, coverageOf, ensureRegistry, AUDIT_ACTION, FINDING_ACTION, readLists };
