'use strict';

const { File, KnowledgeEntry } = require('../../../models');
const { resolveFileOwnership } = require('../../files/fileAccess.service');
const { getFileContent } = require('../../files/files.service');
const E = require('./retrieval.errors');
const { DEFAULT_PERMISSION, CLASSIFICATION_RANK } = require('./retrieval.constants');

/**
 * Origens da ingestão (M9-D022). Passo 1, AUTORIZAÇÃO: só arquivo já registrado no módulo de arquivos da empresa ou conhecimento
 * homologado (M9-D008) ou URL pedida por quem administra a NAY. Solicitante: `ai:admin`, ou dono do arquivo com `ai:use`.
 * `describeSource` devolve os metadados que os chunks herdam (classificação, permissão exigida, dono, vigência) sem ler o conteúdo;
 * `readSource` lê o conteúdo (arquivo decifrado com a conferência de integridade do módulo de arquivos, ou o texto do conhecimento).
 */
const has = (ctx, code) => Array.isArray(ctx.permissions) && ctx.permissions.includes(code);
const isAdmin = (ctx) => has(ctx, 'ai:admin');
const stricter = (a, b) => (!a ? b : !b ? a : (CLASSIFICATION_RANK[a] >= CLASSIFICATION_RANK[b] ? a : b));

async function describeFile(ctx, input, transaction, { system }) {
  const file = await File.findByPk(input.sourceId, { transaction });
  if (!file) throw E.sourceInvalid();
  const owner = file.uploadedByUserId || file.createdBy || null;
  if (!system && !isAdmin(ctx) && !(has(ctx, 'ai:use') && owner && owner === ctx.userId)) throw E.notAuthorized();
  const ownership = await resolveFileOwnership(file.id, transaction);
  const perms = [...ownership.permissions].sort();
  const owned = ownership.hasOwner && perms.length > 0;
  return {
    kind: 'FILE', sourceId: file.id, sourceRef: file.id, file, fileName: file.fileName, mimeType: file.mimeType,
    classification: stricter(file.classification || null, ownership.restricted ? 'RESTRICTED' : null),
    requiredPermission: owned ? perms[0] : DEFAULT_PERMISSION,
    ownerScope: owned ? 'COMPANY' : 'USER', ownerUserId: owned ? null : (owner || ctx.userId || null),
    effectiveFrom: file.createdAt || new Date(), effectiveUntil: null, version: null,
  };
}

async function describeKnowledge(ctx, input, transaction, { system }) {
  const entry = await KnowledgeEntry.findOne({ where: { id: input.sourceId, companyId: ctx.companyId }, transaction });
  if (!entry) throw E.sourceInvalid();
  if (!system && !isAdmin(ctx)) throw E.notAuthorized();
  if (entry.status !== 'HOMOLOGATED' || !entry.isActive) throw E.notAuthorized();
  return {
    kind: 'KNOWLEDGE_ENTRY', sourceId: entry.id, sourceRef: entry.id, entry, classification: entry.classification, requiredPermission: DEFAULT_PERMISSION,
    ownerScope: 'COMPANY', ownerUserId: null, effectiveFrom: entry.validFrom || entry.homologatedAt || new Date(), effectiveUntil: entry.validUntil || null,
    version: entry.version,
  };
}

function describeUrl(ctx, input) {
  if (!isAdmin(ctx)) throw E.notAuthorized();
  return {
    kind: 'URL', sourceId: input.sourceId, sourceRef: input.sourceRef, classification: input.classification, requiredPermission: DEFAULT_PERMISSION,
    ownerScope: 'COMPANY', ownerUserId: null, effectiveFrom: new Date(), effectiveUntil: null, version: null,
  };
}

/** Passo 1 (autorização) e metadados herdados. 403 AI_INGEST_NOT_AUTHORIZED; origem de outra empresa ou inexistente = 404. */
async function describeSource(ctx, input, transaction, { system = false } = {}) {
  if (input.sourceKind === 'FILE') return describeFile(ctx, input, transaction, { system });
  if (input.sourceKind === 'KNOWLEDGE_ENTRY') return describeKnowledge(ctx, input, transaction, { system });
  return describeUrl(ctx, input);
}

const lines = (value, prefix = '') => {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'object') return [`${prefix}${value}`];
  return Object.entries(value).flatMap(([k, v]) => (v !== null && typeof v === 'object' ? [`${k}:`, ...lines(v, '  ')] : [`${prefix}${k}: ${v}`]));
};

/** Texto do conhecimento homologado: título e valor em linhas legíveis. */
function knowledgeText(entry) {
  const body = entry.bodyStructured ? lines(entry.bodyStructured) : [];
  return [`# ${entry.title}`, ...lines(entry.factValueJson), ...body].join('\n');
}

/** Conteúdo da origem de arquivo ou de conhecimento: { buffer, mimeType } (URL é buscada pelo urlFetcher). */
async function readSource(desc, ctx, transaction) {
  if (desc.kind === 'KNOWLEDGE_ENTRY') return { buffer: Buffer.from(knowledgeText(desc.entry), 'utf8'), mimeType: 'text/plain' };
  const loaded = await getFileContent(desc.file.id, transaction, ctx.userId, desc.file);
  return { buffer: loaded.getDataValue('content'), mimeType: desc.file.mimeType };
}

module.exports = { describeSource, readSource, knowledgeText };
