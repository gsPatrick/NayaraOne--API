'use strict';

const { randomUUID } = require('crypto');

/**
 * Migration: Marco 8 Fase 2 (Caderno "CORRESPONDENTE BANCÁRIO + NC + FINANCIAMENTOS") —
 * requirements (checklist de documentos exigidos por caso) e documents (arquivo efetivamente
 * enviado, versionado). Invariantes do Caderno respeitados aqui:
 *   - "Documentos financeiros/identidade são RESTRICTED e versionados" → case_documents tem
 *     `classification` e NUNCA é UPDATE no envio de um novo arquivo pro mesmo requirement —
 *     sempre INSERT de uma nova linha com `version` incrementado (ver
 *     caseDocuments.service.js).
 *   - "Documento substituído preserva versão anterior" → não há UPDATE/DELETE de versão antiga,
 *     só o campo `superseded_at` marcando que não é mais a vigente (índice parcial garante no
 *     máximo UMA linha vigente por requirement).
 *
 * Arquivo binário em si: reusa `people.files` (ver src/features/files), nunca duplicado aqui —
 * `case_documents.file_id` só referencia o metadado já existente.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const sequelize = queryInterface.sequelize;

    const tenantCols = (extra = {}) => ({
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
      group_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'groups', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      company_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'companies', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      ...extra,
    });

    const enableRls = async (table) => {
      await sequelize.query(`ALTER TABLE "correspondent"."${table}" ENABLE ROW LEVEL SECURITY;`);
      await sequelize.query(`ALTER TABLE "correspondent"."${table}" FORCE ROW LEVEL SECURITY;`);
      await sequelize.query(`
        CREATE POLICY tenant_isolation ON "correspondent"."${table}"
          USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
      `);
    };

    await queryInterface.createTable({ tableName: 'case_requirements', schema: 'correspondent' }, tenantCols({
      financing_case_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'financing_cases', schema: 'correspondent' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      document_type: {
        type: Sequelize.STRING(40), allowNull: false,
        comment: 'RG_CPF|COMPROVANTE_RENDA|COMPROVANTE_RESIDENCIA|MATRICULA_IMOVEL|CERTIDAO_ESTADO_CIVIL|IPTU|OUTRO',
      },
      required: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      status: {
        type: Sequelize.STRING(16), allowNull: false, defaultValue: 'PENDING',
        comment: 'PENDING|SUBMITTED|VALIDATED|REJECTED|EXPIRED',
      },
      notes: { type: Sequelize.TEXT, allowNull: true },
      created_by: { type: Sequelize.UUID, allowNull: true },
      updated_by: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    }));
    await enableRls('case_requirements');

    await queryInterface.createTable({ tableName: 'case_documents', schema: 'correspondent' }, tenantCols({
      financing_case_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'financing_cases', schema: 'correspondent' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      requirement_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'case_requirements', schema: 'correspondent' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      file_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'files', schema: 'people' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      classification: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'RESTRICTED', comment: 'RESTRICTED (documentos financeiros/identidade são sempre RESTRICTED neste marco).' },
      superseded_at: { type: Sequelize.DATE, allowNull: true, comment: 'Preenchido quando uma versão mais nova é enviada pro mesmo requirement — nunca apagado.' },
      uploaded_by: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    }));
    // No máximo UMA versão vigente (superseded_at IS NULL) por requirement — garante em DB, não
    // só em service, que o histórico nunca fica com duas linhas "atuais" simultâneas.
    await sequelize.query(`
      CREATE UNIQUE INDEX case_documents_requirement_current_unique
        ON "correspondent"."case_documents" (requirement_id)
        WHERE superseded_at IS NULL;
    `);
    await enableRls('case_documents');

    // ACHADO REAL (mesma classe de bug já documentada em PADRAO_COMPONENTES_E_REGRAS.md §2.4):
    // o `ALTER DEFAULT PRIVILEGES FOR ROLE nayara_migration` da migration 336 nunca se aplica de
    // verdade, porque a credencial real usada para rodar migrations (`DB_MIGRATION_USER`, ver
    // .env.migration.local) é "nayaraonebanco", não o role "nayara_migration" — tabelas criadas
    // por uma migration SEMPRE ficam sem o GRANT automático. GRANT explícito aqui, nas duas
    // tabelas novas, em vez de confiar no default privileges que nunca dispara.
    const [[{ exists: runtimeExists }]] = await sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (runtimeExists) {
      await sequelize.query('GRANT SELECT, INSERT, UPDATE, DELETE ON "correspondent"."case_requirements" TO nayara_runtime;');
      await sequelize.query('GRANT SELECT, INSERT, UPDATE, DELETE ON "correspondent"."case_documents" TO nayara_runtime;');
    }

    // Permissão dedicada pra ver/baixar documentos RESTRICTED — distinta de "correspondent:read"
    // (que só dá acesso aos dados do caso, não aos arquivos de identidade/renda em si).
    const CODE = ['correspondent:documents:read', 'Ver e baixar documentos RESTRICTED (identidade/renda) de casos de financiamento.', 'HIGH'];
    await sequelize.query(
      `INSERT INTO core.permissions (id, code, description, risk_level, created_at, updated_at)
       SELECT :id, :code, :description, :risk, now(), now()
       WHERE NOT EXISTS (SELECT 1 FROM core.permissions WHERE code = :code)`,
      { replacements: { id: randomUUID(), code: CODE[0], description: CODE[1], risk: CODE[2] } }
    );
    await sequelize.query('ALTER TABLE core.companies NO FORCE ROW LEVEL SECURITY');
    await sequelize.query('ALTER TABLE core.roles NO FORCE ROW LEVEL SECURITY');
    try {
      await sequelize.query(
        `
        INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
        SELECT gen_random_uuid(), r.id, p.id, now(), now()
        FROM core.roles r
        CROSS JOIN core.permissions p
        WHERE r.name = 'ADMIN' AND p.code = :code
          AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)
        `,
        { replacements: { code: CODE[0] } }
      );
    } finally {
      await sequelize.query('ALTER TABLE core.companies FORCE ROW LEVEL SECURITY');
      await sequelize.query('ALTER TABLE core.roles FORCE ROW LEVEL SECURITY');
    }
  },

  down: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    const dropWithPolicy = async (table) => {
      await sequelize.query(`DROP POLICY IF EXISTS tenant_isolation ON "correspondent"."${table}";`);
      await sequelize.query(`ALTER TABLE "correspondent"."${table}" DISABLE ROW LEVEL SECURITY;`);
      await queryInterface.dropTable({ tableName: table, schema: 'correspondent' });
    };
    await dropWithPolicy('case_documents');
    await dropWithPolicy('case_requirements');
  },
};
