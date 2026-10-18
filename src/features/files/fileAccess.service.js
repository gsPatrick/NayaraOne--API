'use strict';

const { sequelize, File } = require('../../models');
const AppError = require('../../utils/AppError');

/**
 * Autorização de leitura de arquivo pelo módulo dono (RBAC-02, auditoria Nayara 18/10/2026).
 *
 * GET /files/:id e GET /files/:id/content são rotas transversais: o RLS isola empresas, mas
 * dentro da mesma empresa qualquer usuário autenticado lia qualquer arquivo — um perfil sem
 * legal:read baixava documento de contrato. A regra agora: o usuário precisa da permissão de
 * leitura de PELO MENOS UM módulo que referencia o arquivo, ou ter feito o upload dele.
 * Arquivo sem nenhum vínculo conhecido (ex.: recém-enviado, ainda não anexado): só o uploader
 * ou um administrador.
 *
 * Os vínculos não são FKs no banco (as colunas de arquivo não têm constraint), por isso a lista
 * abaixo é a fonte única de "quem é dono de um arquivo". Coluna nova que guarde arquivo precisa
 * entrar aqui — senão o arquivo cai na regra restritiva (só uploader/admin), nunca na permissiva.
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
  { table: 'construction.daily_logs', column: 'evidence_file_ids', kind: 'uuid_array', permissions: ['construction:read'] },
  { table: 'construction.daily_reports', column: 'evidence_file_ids', kind: 'uuid_array', permissions: ['construction:read'] },
  { table: 'construction.daily_workers', column: 'document_file_ids', kind: 'uuid_array', permissions: ['construction:read'] },
  { table: 'construction.maintenance_cases', column: 'before_media_file_ids', kind: 'uuid_array', permissions: ['construction:read'] },
  { table: 'construction.maintenance_cases', column: 'after_media_file_ids', kind: 'uuid_array', permissions: ['construction:read'] },
  { table: 'construction.nonconformities', column: 'before_evidence_file_ids', kind: 'uuid_array', permissions: ['construction:read'] },
  { table: 'construction.nonconformities', column: 'after_evidence_file_ids', kind: 'uuid_array', permissions: ['construction:read'] },
  { table: 'construction.warranty_cases', column: 'before_media_file_ids', kind: 'uuid_array', permissions: ['construction:read'] },
  { table: 'construction.warranty_cases', column: 'after_media_file_ids', kind: 'uuid_array', permissions: ['construction:read'] },
];

// people.file_links: vínculo genérico arquivo ↔ entidade.
const FILE_LINK_ENTITY_PERMISSIONS = {
  InspectionItem: ['legal:read'],
  LegalCase: ['legal:read'],
  InsurancePolicy: ['procurement:read'],
  AssetMovement: ['inventory:read'],
  FinancialEntry: ['finance:read'],
};

// Categoria gravada no upload: indica o módulo mesmo antes do vínculo existir.
const CATEGORY_PERMISSIONS = {
  contracts: ['legal:read'],
  'contracts-signed': ['legal:read'],
  inspections: ['legal:read'],
  'people-documents': ['people:read'],
  'property-documents': ['properties:read'],
  insurance: ['procurement:read'],
  'inventory-invoices': ['inventory:read'],
};

function referenceCondition(kind, column) {
  if (kind === 'uuid_array') return `:fileId = ANY(${column})`;
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
  return parts.join(' UNION ALL ');
}

const REFERENCES_QUERY = buildReferencesQuery();

/**
 * Devolve o conjunto de permissões que dão acesso de leitura ao arquivo (qualquer uma basta).
 * Conjunto vazio = arquivo sem módulo dono conhecido.
 */
async function resolveFileReadPermissions(file, transaction) {
  const [rows] = await sequelize.query(REFERENCES_QUERY, { replacements: { fileId: file.id }, transaction });
  const allowed = new Set();
  for (const row of rows) {
    if (row.ref === -1) {
      (FILE_LINK_ENTITY_PERMISSIONS[row.related_entity_type] || []).forEach((p) => allowed.add(p));
    } else {
      FILE_REFERENCES[row.ref].permissions.forEach((p) => allowed.add(p));
    }
  }
  (CATEGORY_PERMISSIONS[categoryFromStorageKey(file.storageKey)] || []).forEach((p) => allowed.add(p));
  return allowed;
}

// A categoria do upload não tem coluna própria: fica no primeiro segmento do storageKey
// ("contracts/<groupId>/<arquivo>", ver diskStorage.saveFile). Arquivos antigos "local-db/..."
// não têm categoria — dependem só dos vínculos.
function categoryFromStorageKey(storageKey) {
  if (!storageKey) return null;
  return String(storageKey).split('/')[0] || null;
}

function isAdmin(roles) {
  return (roles || []).some((role) => String(role).toLowerCase() === 'admin');
}

/**
 * assertCanReadFile — 404 se o arquivo não existe no tenant (RLS), 403 com FILE_ACCESS_FORBIDDEN
 * se o usuário não tem a leitura de nenhum módulo dono e não é o uploader.
 */
async function assertCanReadFile(fileId, auth, transaction) {
  const file = await File.findByPk(fileId, { attributes: ['id', 'storageKey', 'uploadedByUserId', 'createdBy'], transaction });
  if (!file) {
    throw AppError.notFound('Arquivo não encontrado.', 'FILE_NOT_FOUND');
  }
  const uploaderId = file.uploadedByUserId || file.createdBy;
  if (uploaderId && uploaderId === auth.userId) return;

  const allowed = await resolveFileReadPermissions(file, transaction);
  const permissions = auth.permissions || [];
  if (allowed.size === 0) {
    if (isAdmin(auth.roles)) return;
  } else if ([...allowed].some((p) => permissions.includes(p))) {
    return;
  }
  throw AppError.forbidden(
    'Você não tem permissão para acessar este arquivo — é preciso ter acesso de leitura ao módulo a que ele pertence.',
    'FILE_ACCESS_FORBIDDEN'
  );
}

module.exports = { assertCanReadFile, resolveFileReadPermissions, FILE_REFERENCES, FILE_LINK_ENTITY_PERMISSIONS, CATEGORY_PERMISSIONS };
