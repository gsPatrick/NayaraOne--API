'use strict';

/**
 * Revisão independente do RBAC-02 (conferência Nayara 18/10/2026):
 *
 * 1. people.files.encrypted_at_rest (I4). Linhas existentes ficam false (legado: podem estar em
 *    texto puro em disco ou no BLOB local-db/); todo arquivo novo nasce true (default da coluna e
 *    do model). Com true, a leitura recusa conteúdo sem o marcador de cifra.
 *
 * 2. Índices para a consulta de "módulo dono do arquivo" (fileAccess.service#REFERENCES_QUERY),
 *    executada em toda leitura e em todo vínculo de arquivo. Nenhuma das colunas de arquivo tinha
 *    índice. btree para uuid, GIN para uuid[] (consulta usa @> ARRAY[...]) e para jsonb (@>).
 *    Sem GRANT novo: só colunas e índices em tabelas já existentes.
 */

const UUID_COLUMNS = [
  ['legal', 'contract_versions', 'document_file_id'],
  ['legal', 'contract_versions', 'signed_document_file_id'],
  ['legal', 'contract_amendments', 'document_file_id'],
  ['legal', 'contract_requirements', 'satisfied_by_file_id'],
  ['legal', 'legal_deadlines', 'conclusion_evidence_file_id'],
  ['legal', 'notices', 'content_file_id'],
  ['legal', 'notices', 'delivery_evidence_file_id'],
  ['finance', 'financial_entries', 'settlement_evidence_file_id'],
  ['finance', 'tax_documents', 'file_id'],
  ['finance', 'utility_obligations', 'evidence_file_id'],
  ['finance', 'ownership_transfer_tasks', 'evidence_file_id'],
  ['inventory', 'inventory_movements', 'evidence_file_id'],
  ['inventory', 'receipts', 'invoice_file_id'],
  ['correspondent', 'case_documents', 'file_id'],
  ['people', 'person_documents', 'file_id'],
  ['people', 'file_links', 'file_id'],
];

const GIN_COLUMNS = [
  ['legal', 'key_deliveries', 'photos_file_ids'],
  ['procurement', 'supplier_qualifications', 'document_file_ids'],
  ['inventory', 'loss_cases', 'evidence_file_ids'],
  ['construction', 'change_orders', 'evidence_file_ids'],
  ['construction', 'daily_reports', 'evidence_file_ids'],
  ['construction', 'daily_workers', 'document_file_ids'],
  ['construction', 'maintenance_cases', 'before_media_file_ids'],
  ['construction', 'maintenance_cases', 'after_media_file_ids'],
  ['construction', 'nonconformities', 'before_evidence_file_ids'],
  ['construction', 'nonconformities', 'after_evidence_file_ids'],
];

function indexName(table, column) {
  return `idx_${table}_${column}_fileaccess`.slice(0, 63);
}

module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);

    await q(`ALTER TABLE "people"."files" ADD COLUMN IF NOT EXISTS "encrypted_at_rest" BOOLEAN NOT NULL DEFAULT false`);
    await q(`ALTER TABLE "people"."files" ALTER COLUMN "encrypted_at_rest" SET DEFAULT true`);

    for (const [schema, table, column] of UUID_COLUMNS) {
      await q(`CREATE INDEX IF NOT EXISTS "${indexName(table, column)}" ON "${schema}"."${table}" ("${column}")`);
    }
    for (const [schema, table, column] of GIN_COLUMNS) {
      await q(`CREATE INDEX IF NOT EXISTS "${indexName(table, column)}" ON "${schema}"."${table}" USING GIN ("${column}")`);
    }
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    for (const [schema, table, column] of [...UUID_COLUMNS, ...GIN_COLUMNS]) {
      await q(`DROP INDEX IF EXISTS "${schema}"."${indexName(table, column)}"`);
    }
    await q(`ALTER TABLE "people"."files" DROP COLUMN IF EXISTS "encrypted_at_rest"`);
  },
};
