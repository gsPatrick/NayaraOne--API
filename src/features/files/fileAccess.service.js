'use strict';

const { sequelize, File } = require('../../models');
const AppError = require('../../utils/AppError');

/**
 * Autorização de arquivo pelo módulo dono (RBAC-02, conferência Nayara 18/10/2026; revisão
 * independente de 18/10).
 *
 * Leitura (GET /files/:id e GET /files/:id/content):
 *  - Arquivo COM dono (referenciado por alguma coluna abaixo ou por people.file_links): é
 *    preciso ter a leitura de PELO MENOS UM módulo dono. Ter feito o upload não basta — quem
 *    perdeu a permissão do módulo, ou enviou um arquivo que depois passou a pertencer a um
 *    contrato sigiloso, não lê mais (I3).
 *  - Arquivo SEM dono (recém-enviado, ainda não anexado): o próprio uploader (pré-visualização
 *    logo após o upload), quem tem a leitura do módulo indicado pela categoria do upload, ou um
 *    administrador da empresa. A categoria vem do corpo do POST /files e não é verificada — por
 *    isso ela só conta enquanto o arquivo não tem vínculo nenhum (I2).
 *
 * Vínculo (qualquer escrita que receba IDs de arquivo — ver fileAttachGuard.middleware.js): o
 * ator só anexa um arquivo que ele já pode ler (I1). Sem isso, a regra "basta um módulo dono"
 * virava escalada: um usuário de Obras punha o UUID de um documento de contrato nas evidências
 * de um RDO e passava a baixá-lo com construction:read.
 *
 * As colunas abaixo são a fonte única de "quem é dono de um arquivo". Várias têm FK para
 * people.files (migrations 039, 057, 108, 144, 180, 338, 381), outras não (arrays uuid[] e
 * jsonb não admitem FK) — por isso a lista é mantida aqui, e não derivada das constraints.
 * Coluna nova que guarde arquivo precisa entrar aqui; se esquecer, o arquivo fica sem dono e
 * cai na regra restritiva (só uploader/admin), nunca na permissiva.
 *
 * As views construction.daily_logs (sobre daily_reports) e construction.warranty_cases (sobre
 * maintenance_cases) NÃO entram: repetiam as mesmas colunas das tabelas base e só dobravam o
 * custo da consulta.
 */

// kind: 'uuid' (coluna escalar), 'uuid_array' (uuid[]), 'jsonb_array' (jsonb com array de ids).
const FILE_REFERENCES = [
  { table: 'legal.contract_versions', column: 'document_file_id', kind: 'uuid', permissions: ['legal:read'] },
  { table: 'legal.contract_versions', column: 'signed_document_file_id', kind: 'uuid', permissions: ['legal:read'] },
  { table: 'legal.contract_amendments', column: 'document_file_id', kind: 'uuid', permissions: ['legal:read'] },
  { table: 'legal.contract_requirements', column: 'satisfied_by_file_id', kind: 'uuid', permissions: ['legal:read'] },
  { table: 'legal.legal_deadlines', column: 'conclusion_evidence_file_id', kind: 'uuid', permissions: ['legal:read'] },
  { table: 'legal.notices', column: 'content_file_id', kind: 'uuid', permissions: ['legal:read'] },
  { table: 'legal.notices', column: 'delivery_evidence_file_id', kind: 'uuid', permissions: ['legal:read'] },
  { table: 'legal.key_deliveries', column: 'photos_file_ids', kind: 'jsonb_array', permissions: ['legal:read'] },
  { table: 'finance.financial_entries', column: 'settlement_evidence_file_id', kind: 'uuid', permissions: ['finance:read'] },
  { table: 'finance.tax_documents', column: 'file_id', kind: 'uuid', permissions: ['correspondent:fiscal', 'finance:read'] },
  { table: 'finance.utility_obligations', column: 'evidence_file_id', kind: 'uuid', permissions: ['billing:read'] },
  { table: 'finance.ownership_transfer_tasks', column: 'evidence_file_id', kind: 'uuid', permissions: ['billing:read'] },
  { table: 'inventory.inventory_movements', column: 'evidence_file_id', kind: 'uuid', permissions: ['inventory:read'] },
  { table: 'inventory.loss_cases', column: 'evidence_file_ids', kind: 'uuid_array', permissions: ['inventory:read'] },
  { table: 'inventory.receipts', column: 'invoice_file_id', kind: 'uuid', permissions: ['inventory:read'] },
  { table: 'procurement.supplier_qualifications', column: 'document_file_ids', kind: 'jsonb_array', permissions: ['procurement:read'] },
  { table: 'correspondent.case_documents', column: 'file_id', kind: 'uuid', permissions: ['correspondent:read'] },
  { table: 'people.person_documents', column: 'file_id', kind: 'uuid', permissions: ['people:read'] },
  { table: 'construction.change_orders', column: 'evidence_file_ids', kind: 'uuid_array', permissions: ['construction:read'] },
  { table: 'construction.daily_reports', column: 'evidence_file_ids', kind: 'uuid_array', permissions: ['construction:read'] },
  { table: 'construction.daily_workers', column: 'document_file_ids', kind: 'uuid_array', permissions: ['construction:read'] },
  { table: 'construction.maintenance_cases', column: 'before_media_file_ids', kind: 'uuid_array', permissions: ['construction:read'] },
  { table: 'construction.maintenance_cases', column: 'after_media_file_ids', kind: 'uuid_array', permissions: ['construction:read'] },
  { table: 'construction.nonconformities', column: 'before_evidence_file_ids', kind: 'uuid_array', permissions: ['construction:read'] },
  { table: 'construction.nonconformities', column: 'after_evidence_file_ids', kind: 'uuid_array', permissions: ['construction:read'] },
];

// people.file_links: vínculo genérico arquivo ↔ entidade. Só os tipos que o código de fato grava
// (inspections.service, insurance.service, assets.service). Tipo desconhecido não dá permissão:
// o arquivo conta como "com dono" e ninguém lê até o tipo ser mapeado aqui (fail closed).
const FILE_LINK_ENTITY_PERMISSIONS = {
  InspectionItem: ['legal:read'],
  InsurancePolicy: ['procurement:read'],
  AssetMovement: ['inventory:read'],
};

// Categoria gravada no upload: só vale para arquivo ainda sem vínculo (ver cabeçalho).
const CATEGORY_PERMISSIONS = {
  contracts: ['legal:read'],
  'contracts-signed': ['legal:read'],
  inspections: ['legal:read'],
  'people-documents': ['people:read'],
  'property-documents': ['properties:read'],
  insurance: ['procurement:read'],
  'inventory-invoices': ['inventory:read'],
  correspondent: ['correspondent:read'],
};

// Os predicados usam operadores que os índices da migration 20260101000395 atendem: btree para
// uuid, GIN (array_ops) para uuid[] via @>, GIN (jsonb_ops) para jsonb via @>.
function referenceCondition(kind, column) {
  if (kind === 'uuid_array') return `${column} @> ARRAY[CAST(:fileId AS uuid)]`;
  if (kind === 'jsonb_array') return `${column} @> jsonb_build_array(CAST(:fileId AS text))`;
  return `${column} = :fileId`;
}

function buildReferencesQuery() {
  const parts = FILE_REFERENCES.map(
    (ref, index) =>
      `(SELECT ${index} AS ref, NULL::text AS related_entity_type FROM ${ref.table} WHERE ${referenceCondition(ref.kind, ref.column)} LIMIT 1)`
  );
  parts.push(
    `(SELECT -1 AS ref, related_entity_type::text FROM people.file_links WHERE file_id = :fileId AND deleted_at IS NULL)`
  );
  // Não é vínculo: marca documento RESTRICTED do Correspondente, que exige ainda
  // correspondent:documents:read (files.controller). Vem na mesma consulta para não gastar outra
  // ida ao banco a cada download.
  parts.push(
    `(SELECT ${RESTRICTED_MARKER} AS ref, NULL::text FROM correspondent.case_documents WHERE file_id = :fileId AND classification = 'RESTRICTED' LIMIT 1)`
  );
  return parts.join(' UNION ALL ');
}

const RESTRICTED_MARKER = -2;
const REFERENCES_QUERY = buildReferencesQuery();

/**
 * Donos do arquivo: `hasOwner` diz se há QUALQUER vínculo (inclusive file_links de tipo não
 * mapeado); `permissions` é o conjunto de leituras que dão acesso (qualquer uma basta);
 * `restricted` indica documento RESTRICTED do Correspondente.
 */
async function resolveFileOwnership(fileId, transaction) {
  const [rows] = await sequelize.query(REFERENCES_QUERY, { replacements: { fileId }, transaction });
  const permissions = new Set();
  let hasOwner = false;
  let restricted = false;
  for (const row of rows) {
    if (row.ref === RESTRICTED_MARKER) {
      restricted = true;
      continue;
    }
    hasOwner = true;
    if (row.ref === -1) {
      (FILE_LINK_ENTITY_PERMISSIONS[row.related_entity_type] || []).forEach((p) => permissions.add(p));
    } else {
      FILE_REFERENCES[row.ref].permissions.forEach((p) => permissions.add(p));
    }
  }
  return { hasOwner, permissions, restricted };
}

// A categoria do upload não tem coluna própria: fica no primeiro segmento do storageKey
// ("contracts/<groupId>/<arquivo>", ver diskStorage.saveFile). Arquivos antigos "local-db/..."
// não têm categoria.
function categoryFromStorageKey(storageKey) {
  if (!storageKey) return null;
  return String(storageKey).split('/')[0] || null;
}

/**
 * Administrador da empresa = vínculo ATIVO com a role de SISTEMA "ADMIN" (criada pelo seed,
 * `is_system = true`). Nunca pelo nome de role vindo do JWT: roles criadas pela API nascem com
 * `is_system = false` (roles.service), então quem tem roles:create não fabrica um "admin".
 */
async function isCompanyAdmin(auth, transaction) {
  if (!auth || !auth.userId || !auth.companyId) return false;
  const [rows] = await sequelize.query(
    `SELECT 1
       FROM core.user_memberships m
       JOIN core.roles r ON r.id = m.role_id AND r.deleted_at IS NULL
      WHERE m.user_id = :userId
        AND m.company_id = :companyId
        AND m.status = 'ACTIVE'
        AND m.deleted_at IS NULL
        AND r.is_system = true
        AND r.name = 'ADMIN'
      LIMIT 1`,
    { replacements: { userId: auth.userId, companyId: auth.companyId }, transaction }
  );
  return rows.length > 0;
}

async function evaluateReadAccess(file, auth, transaction) {
  const permissions = auth.permissions || [];
  const ownership = await resolveFileOwnership(file.id, transaction);
  let allowed;
  if (ownership.hasOwner) {
    allowed = [...ownership.permissions].some((p) => permissions.includes(p));
  } else {
    const uploaderId = file.uploadedByUserId || file.createdBy;
    const categoryPermissions = CATEGORY_PERMISSIONS[categoryFromStorageKey(file.storageKey)] || [];
    allowed =
      Boolean(uploaderId && uploaderId === auth.userId) ||
      categoryPermissions.some((p) => permissions.includes(p)) ||
      (await isCompanyAdmin(auth, transaction));
  }
  return { allowed, ownership };
}

async function canReadFile(file, auth, transaction) {
  return (await evaluateReadAccess(file, auth, transaction)).allowed;
}

const FILE_ATTRIBUTES = ['id', 'storageKey', 'uploadedByUserId', 'createdBy'];

/**
 * assertCanReadFile — 404 se o arquivo não existe no tenant (RLS), 403 FILE_ACCESS_FORBIDDEN se
 * o usuário não pode ler (regras no cabeçalho). Devolve o metadado completo do arquivo (sem o
 * binário) e se ele é documento RESTRICTED, para o controller não repetir as mesmas consultas.
 */
async function assertCanReadFile(fileId, auth, transaction) {
  const file = await File.findByPk(fileId, { transaction });
  if (!file) {
    throw AppError.notFound('Arquivo não encontrado.', 'FILE_NOT_FOUND');
  }
  const { allowed, ownership } = await evaluateReadAccess(file, auth, transaction);
  if (!allowed) {
    throw AppError.forbidden(
      'Você não tem permissão para acessar este arquivo — é preciso ter acesso de leitura ao módulo a que ele pertence.',
      'FILE_ACCESS_FORBIDDEN'
    );
  }
  return { file, restricted: ownership.restricted };
}

/**
 * assertCanAttachFiles — o ator só vincula arquivo que ele já pode ler (I1). IDs que não
 * existem no tenant são ignorados aqui: cada serviço já responde com o próprio erro de
 * negócio para arquivo inexistente, e este guard não deve trocar esses códigos.
 */
async function assertCanAttachFiles(fileIds, auth, transaction) {
  const unique = [...new Set((fileIds || []).filter(Boolean).map(String))];
  if (unique.length === 0) return;
  const files = await File.findAll({ where: { id: unique }, attributes: FILE_ATTRIBUTES, transaction });
  for (const file of files) {
    // Documento RESTRICTED do Correspondente só é reaproveitado por quem tem a permissão dedicada.
    const { restricted } = await resolveFileOwnership(file.id, transaction);
    if (restricted && !(auth?.permissions || []).includes('correspondent:documents:read')) {
      throw AppError.forbidden(
        'Este arquivo é um documento restrito de outro caso. Você não tem permissão para reutilizá-lo.',
        'FILE_ATTACH_FORBIDDEN',
        { fileId: file.id }
      );
    }
    if (!(await canReadFile(file, auth, transaction))) {
      throw AppError.forbidden(
        'Você não pode anexar um arquivo que não tem permissão para acessar — envie um arquivo seu ou peça a quem tem acesso ao módulo dele.',
        'FILE_ATTACH_FORBIDDEN',
        { fileId: file.id }
      );
    }
  }
}

module.exports = {
  assertCanReadFile,
  assertCanAttachFiles,
  canReadFile,
  resolveFileOwnership,
  isCompanyAdmin,
  FILE_REFERENCES,
  FILE_LINK_ENTITY_PERMISSIONS,
  CATEGORY_PERMISSIONS,
  REFERENCES_QUERY,
};
