'use strict';

/**
 * Migration: Marco 7 — "Insurance Hub" (Caderno "COMPRAS/PROCUREMENT + SEGUROS — BLINDADO +
 * GUIA", contrato 00000009 Anexo I, linha ~9513): "policies, parties, coverages, installments,
 * claims, claim_events, renewal_tasks, provider_submissions. Apólice com
 * provider/número/vigência/cobertura/prêmio/documentos; renovação alerta; sinistro timeline;
 * indenização confirmada integra Financeiro."
 *
 * Gap real encontrado em 2026-10-05: o Marco 7 (Estoque/Patrimônio/Compras) já estava aceito e
 * testado, mas esta sub-funcionalidade nunca foi construída — zero tabela, zero adapter. Esta
 * migration fecha esse gap, no schema "procurement" já existente. GRANT explícito pras 8
 * tabelas novas no final do `up()` — ver comentário ali pra entender por que NÃO dá pra confiar
 * só no ALTER DEFAULT PRIVILEGES de 20260101000269 (achado real na auditoria de 2026-10-05).
 *
 * `insurance_provider_submissions` é a ÚNICA tabela sem RLS aqui — mesmo padrão de
 * `legal.signature_provider_routing`/`finance.bank_payment_provider_routing`: webhook público da
 * seguradora chega sem JWT/tenant conhecido, precisa resolver group_id/company_id ANTES de
 * qualquer SET LOCAL.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
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
      await queryInterface.sequelize.query(`ALTER TABLE "procurement"."${table}" ENABLE ROW LEVEL SECURITY;`);
      await queryInterface.sequelize.query(`ALTER TABLE "procurement"."${table}" FORCE ROW LEVEL SECURITY;`);
      await queryInterface.sequelize.query(`
        CREATE POLICY tenant_isolation ON "procurement"."${table}"
          USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
      `);
    };

    // insurance_policies
    await queryInterface.createTable({ tableName: 'insurance_policies', schema: 'procurement' }, tenantCols({
      property_id: {
        type: Sequelize.UUID, allowNull: true,
        references: { model: { tableName: 'properties', schema: 'real_estate' }, key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
      },
      contract_id: {
        type: Sequelize.UUID, allowNull: true,
        references: { model: { tableName: 'contracts', schema: 'legal' }, key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
      },
      provider: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'sandbox', comment: 'sandbox|porto_seguro|junto_seguros|yelum' },
      external_policy_number: { type: Sequelize.STRING(128), allowNull: true },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'DRAFT', comment: 'DRAFT|QUOTED|ISSUED|ACTIVE|EXPIRED|CANCELED' },
      coverage_summary: { type: Sequelize.TEXT, allowNull: true },
      premium_amount: { type: Sequelize.DECIMAL(18, 2), allowNull: true },
      effective_date: { type: Sequelize.DATEONLY, allowNull: true },
      expiry_date: { type: Sequelize.DATEONLY, allowNull: true },
      quote_snapshot: { type: Sequelize.JSONB, allowNull: true, comment: 'Resposta crua da cotação do provider, pra auditoria.' },
      lock_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_by: { type: Sequelize.UUID, allowNull: true },
      updated_by: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    }));
    await enableRls('insurance_policies');

    // insurance_policy_parties
    await queryInterface.createTable({ tableName: 'insurance_policy_parties', schema: 'procurement' }, tenantCols({
      policy_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'insurance_policies', schema: 'procurement' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      party_role: { type: Sequelize.STRING(24), allowNull: false, comment: 'INSURED|BENEFICIARY|PROPERTY_OWNER' },
      person_id: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    }));
    await enableRls('insurance_policy_parties');

    // insurance_coverages
    await queryInterface.createTable({ tableName: 'insurance_coverages', schema: 'procurement' }, tenantCols({
      policy_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'insurance_policies', schema: 'procurement' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      coverage_type: { type: Sequelize.STRING(64), allowNull: false },
      limit_amount: { type: Sequelize.DECIMAL(18, 2), allowNull: true },
      description: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    }));
    await enableRls('insurance_coverages');

    // insurance_installments
    await queryInterface.createTable({ tableName: 'insurance_installments', schema: 'procurement' }, tenantCols({
      policy_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'insurance_policies', schema: 'procurement' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      financial_entry_id: {
        type: Sequelize.UUID, allowNull: true,
        references: { model: { tableName: 'financial_entries', schema: 'finance' }, key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
      },
      due_date: { type: Sequelize.DATEONLY, allowNull: false },
      amount: { type: Sequelize.DECIMAL(18, 2), allowNull: false },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'PENDING', comment: 'PENDING|PAID|OVERDUE' },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    }));
    await enableRls('insurance_installments');

    // insurance_claims
    await queryInterface.createTable({ tableName: 'insurance_claims', schema: 'procurement' }, tenantCols({
      policy_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'insurance_policies', schema: 'procurement' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      financial_entry_id: {
        type: Sequelize.UUID, allowNull: true,
        references: { model: { tableName: 'financial_entries', schema: 'finance' }, key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
      },
      external_claim_id: { type: Sequelize.STRING(128), allowNull: true },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'OPEN', comment: 'OPEN|SUBMITTED|UNDER_REVIEW|APPROVED|REJECTED|SETTLED' },
      description: { type: Sequelize.TEXT, allowNull: true },
      claim_amount: { type: Sequelize.DECIMAL(18, 2), allowNull: true },
      settled_amount: { type: Sequelize.DECIMAL(18, 2), allowNull: true },
      opened_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      settled_at: { type: Sequelize.DATE, allowNull: true },
      lock_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_by: { type: Sequelize.UUID, allowNull: true },
      updated_by: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    }));
    await enableRls('insurance_claims');

    // insurance_claim_events (timeline do sinistro)
    await queryInterface.createTable({ tableName: 'insurance_claim_events', schema: 'procurement' }, tenantCols({
      claim_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'insurance_claims', schema: 'procurement' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      event_type: { type: Sequelize.STRING(32), allowNull: false, comment: 'OPENED|SUBMITTED|STATUS_CHANGED|SETTLED|REJECTED' },
      notes: { type: Sequelize.TEXT, allowNull: true },
      actor_user_id: { type: Sequelize.UUID, allowNull: true },
      occurred_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    }));
    await enableRls('insurance_claim_events');

    // insurance_renewal_tasks
    await queryInterface.createTable({ tableName: 'insurance_renewal_tasks', schema: 'procurement' }, tenantCols({
      policy_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'insurance_policies', schema: 'procurement' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      due_date: { type: Sequelize.DATEONLY, allowNull: false },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'PENDING', comment: 'PENDING|DONE|DISMISSED' },
      assigned_to_user_id: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    }));
    await enableRls('insurance_renewal_tasks');

    // insurance_provider_submissions — SEM RLS (routing table pro webhook público resolver tenant)
    await queryInterface.createTable({ tableName: 'insurance_provider_submissions', schema: 'procurement' }, {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
      group_id: { type: Sequelize.UUID, allowNull: false },
      company_id: { type: Sequelize.UUID, allowNull: false },
      policy_id: {
        type: Sequelize.UUID, allowNull: true,
        references: { model: { tableName: 'insurance_policies', schema: 'procurement' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      claim_id: {
        type: Sequelize.UUID, allowNull: true,
        references: { model: { tableName: 'insurance_claims', schema: 'procurement' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      provider: { type: Sequelize.STRING(32), allowNull: false },
      submission_type: { type: Sequelize.STRING(16), allowNull: false, comment: 'QUOTE|ISSUE|CLAIM' },
      external_submission_id: { type: Sequelize.STRING(255), allowNull: false },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'PENDING' },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
    await queryInterface.addConstraint({ tableName: 'insurance_provider_submissions', schema: 'procurement' }, {
      fields: ['external_submission_id'],
      type: 'unique',
      name: 'insurance_provider_submissions_external_id_unique',
    });
    await queryInterface.addIndex({ tableName: 'insurance_provider_submissions', schema: 'procurement' }, ['policy_id']);
    await queryInterface.addIndex({ tableName: 'insurance_provider_submissions', schema: 'procurement' }, ['claim_id']);

    // BUG REAL CORRIGIDO (auditoria "loop até secar", 2026-10-05, rodada 1): o comentário
    // original deste arquivo dizia que essas 8 tabelas "herdam os GRANTs de runtime já
    // concedidos em 20260101000269 via ALTER DEFAULT PRIVILEGES" — falso na prática.
    // `ALTER DEFAULT PRIVILEGES FOR ROLE nayara_migration` só se aplica a objetos CRIADOS pela
    // role nayara_migration a partir dali; toda migration deste projeto roda de fato via
    // `DATABASE_URL`/`DB_USER=nayara_runtime` (confirmado em `.env`/`sequelize-cli.js` —
    // `.env.migration.local` com `DB_MIGRATION_USER=nayara_migration` é um arquivo órfão, sem
    // nenhum script que o use). Como quem criou estas tabelas foi a própria `nayara_runtime`,
    // elas só funcionam hoje por privilégio implícito de owner — não pelo mecanismo descrito.
    // Se a separação de roles documentada em `.env.migration.local` for ativada algum dia, isso
    // quebra com "permission denied for table insurance_*". GRANT explícito aqui, mesmo padrão
    // de 20260101000269, elimina a dependência do ALTER DEFAULT PRIVILEGES que nunca dispara.
    const insuranceTables = [
      'insurance_policies', 'insurance_policy_parties', 'insurance_coverages',
      'insurance_installments', 'insurance_claims', 'insurance_claim_events',
      'insurance_renewal_tasks', 'insurance_provider_submissions',
    ];
    for (const table of insuranceTables) {
      await queryInterface.sequelize.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON "procurement"."${table}" TO nayara_runtime;`
      );
    }
  },

  down: async (queryInterface) => {
    const dropWithPolicy = async (table, hasRls = true) => {
      if (hasRls) {
        await queryInterface.sequelize.query(`DROP POLICY IF EXISTS tenant_isolation ON "procurement"."${table}";`);
        await queryInterface.sequelize.query(`ALTER TABLE "procurement"."${table}" DISABLE ROW LEVEL SECURITY;`);
      }
      await queryInterface.dropTable({ tableName: table, schema: 'procurement' });
    };
    await dropWithPolicy('insurance_provider_submissions', false);
    await dropWithPolicy('insurance_renewal_tasks');
    await dropWithPolicy('insurance_claim_events');
    await dropWithPolicy('insurance_claims');
    await dropWithPolicy('insurance_installments');
    await dropWithPolicy('insurance_coverages');
    await dropWithPolicy('insurance_policy_parties');
    await dropWithPolicy('insurance_policies');
  },
};
