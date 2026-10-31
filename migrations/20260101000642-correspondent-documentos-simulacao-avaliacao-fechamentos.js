'use strict';

/**
 * Migration: Marco 8 — fechamentos da auditoria exaustiva (documentos, simulações, avaliações,
 * histórico de status, contas de provider e antivírus).
 *
 * 1) case_requirements: item de um proponente específico (applicant_id); item dispensado (DISPENSED) com quem/quando/motivo; unicidade de item em
 *    aberto por (caso, tipo), exceto "OUTRO"; CHECK de status; índices.
 * 2) provider_status_history.note: o motivo/observação do registro manual fica no histórico.
 * 3) simulations.rate passa a aceitar nulo (taxa não informada não vira 0%); CHECKs de valores.
 * 4) appraisals: no máximo um pedido em andamento por caso; CHECK de status.
 * 5) provider_accounts: ativo/inativo e unicidade (empresa, provider, rótulo).
 * 6) people.files: resultado do antivírus gravado no arquivo.
 * 7) case_documents: CHECK de classificação e índice por caso.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const q = (sql) => queryInterface.sequelize.query(sql);

    // 1) requirements
    await queryInterface.addColumn({ tableName: 'case_requirements', schema: 'correspondent' }, 'applicant_id', { type: Sequelize.UUID, allowNull: true });
    await queryInterface.addColumn({ tableName: 'case_requirements', schema: 'correspondent' }, 'dismissed_by', { type: Sequelize.UUID, allowNull: true });
    await queryInterface.addColumn({ tableName: 'case_requirements', schema: 'correspondent' }, 'dismissed_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn({ tableName: 'case_requirements', schema: 'correspondent' }, 'dismiss_reason', { type: Sequelize.TEXT, allowNull: true });
    // Duplicatas já existentes: mantém o item mais antigo e dispensa os demais, com motivo registrado.
    await q(`UPDATE "correspondent"."case_requirements" r
      SET status = 'DISPENSED', dismissed_at = now(), dismiss_reason = 'Item duplicado dispensado automaticamente na atualização do sistema.'
      WHERE r.status IN ('PENDING','SUBMITTED','REJECTED') AND r.document_type <> 'OUTRO'
        AND EXISTS (
          SELECT 1 FROM "correspondent"."case_requirements" o
          WHERE o.financing_case_id = r.financing_case_id AND o.document_type = r.document_type
            AND o.status IN ('PENDING','SUBMITTED','REJECTED') AND (o.created_at, o.id) < (r.created_at, r.id)
        );`);
    await q(`ALTER TABLE "correspondent"."case_requirements"
      ADD CONSTRAINT case_requirements_status_check CHECK (status IN ('PENDING','SUBMITTED','VALIDATED','REJECTED','EXPIRED','DISPENSED'));`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS case_requirements_open_type_unique
      ON "correspondent"."case_requirements" (financing_case_id, document_type, COALESCE(applicant_id, '00000000-0000-0000-0000-000000000000'::uuid))
      WHERE status IN ('PENDING','SUBMITTED','REJECTED') AND document_type <> 'OUTRO';`);
    await q('CREATE INDEX IF NOT EXISTS case_requirements_case_idx ON "correspondent"."case_requirements" (company_id, financing_case_id);');

    // 2) histórico de status
    await queryInterface.addColumn({ tableName: 'provider_status_history', schema: 'correspondent' }, 'note', { type: Sequelize.TEXT, allowNull: true });

    // 3) simulações
    await q('ALTER TABLE "correspondent"."simulations" ALTER COLUMN rate DROP NOT NULL;');
    await q(`ALTER TABLE "correspondent"."simulations"
      ADD CONSTRAINT simulations_values_check CHECK (amount > 0 AND term_months > 0 AND monthly_payment > 0 AND (rate IS NULL OR rate >= 0)) NOT VALID;`);

    // 4) avaliações
    await q(`ALTER TABLE "correspondent"."appraisals"
      ADD CONSTRAINT appraisals_status_check CHECK (status IN ('REQUESTED','COMPLETED','FAILED')) NOT VALID;`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS appraisals_one_open_per_case
      ON "correspondent"."appraisals" (financing_case_id) WHERE status = 'REQUESTED';`);

    // 5) contas de provider
    await queryInterface.addColumn({ tableName: 'provider_accounts', schema: 'correspondent' }, 'active', { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true });
    await q(`UPDATE "correspondent"."provider_accounts" a SET active = false
      WHERE EXISTS (SELECT 1 FROM "correspondent"."provider_accounts" o
        WHERE o.company_id = a.company_id AND o.provider_code = a.provider_code AND lower(o.label) = lower(a.label)
          AND (o.created_at, o.id) < (a.created_at, a.id));`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS provider_accounts_label_unique
      ON "correspondent"."provider_accounts" (company_id, provider_code, lower(label)) WHERE active;`);

    // 6) antivírus gravado no arquivo
    await queryInterface.addColumn({ tableName: 'files', schema: 'people' }, 'scan_status', { type: Sequelize.STRING(16), allowNull: true });
    await queryInterface.addColumn({ tableName: 'files', schema: 'people' }, 'scanned_at', { type: Sequelize.DATE, allowNull: true });

    // 7) documentos do caso
    await q(`ALTER TABLE "correspondent"."case_documents"
      ADD CONSTRAINT case_documents_classification_check CHECK (classification IN ('RESTRICTED','INTERNAL','PUBLIC')) NOT VALID;`);
    await q('CREATE INDEX IF NOT EXISTS case_documents_case_idx ON "correspondent"."case_documents" (company_id, financing_case_id);');
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP INDEX IF EXISTS "correspondent"."case_documents_case_idx";');
    await q('ALTER TABLE "correspondent"."case_documents" DROP CONSTRAINT IF EXISTS case_documents_classification_check;');
    await queryInterface.removeColumn({ tableName: 'files', schema: 'people' }, 'scanned_at');
    await queryInterface.removeColumn({ tableName: 'files', schema: 'people' }, 'scan_status');
    await q('DROP INDEX IF EXISTS "correspondent"."provider_accounts_label_unique";');
    await queryInterface.removeColumn({ tableName: 'provider_accounts', schema: 'correspondent' }, 'active');
    await q('DROP INDEX IF EXISTS "correspondent"."appraisals_one_open_per_case";');
    await q('ALTER TABLE "correspondent"."appraisals" DROP CONSTRAINT IF EXISTS appraisals_status_check;');
    await q('ALTER TABLE "correspondent"."simulations" DROP CONSTRAINT IF EXISTS simulations_values_check;');
    await q('UPDATE "correspondent"."simulations" SET rate = 0 WHERE rate IS NULL;');
    await q('ALTER TABLE "correspondent"."simulations" ALTER COLUMN rate SET NOT NULL;');
    await queryInterface.removeColumn({ tableName: 'provider_status_history', schema: 'correspondent' }, 'note');
    await q('DROP INDEX IF EXISTS "correspondent"."case_requirements_case_idx";');
    await q('DROP INDEX IF EXISTS "correspondent"."case_requirements_open_type_unique";');
    await q('ALTER TABLE "correspondent"."case_requirements" DROP CONSTRAINT IF EXISTS case_requirements_status_check;');
    await queryInterface.removeColumn({ tableName: 'case_requirements', schema: 'correspondent' }, 'dismiss_reason');
    await queryInterface.removeColumn({ tableName: 'case_requirements', schema: 'correspondent' }, 'dismissed_at');
    await queryInterface.removeColumn({ tableName: 'case_requirements', schema: 'correspondent' }, 'dismissed_by');
    await queryInterface.removeColumn({ tableName: 'case_requirements', schema: 'correspondent' }, 'applicant_id');
  },
};
