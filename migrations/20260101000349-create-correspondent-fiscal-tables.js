'use strict';

/**
 * Migration: Marco 8 Fase 12 — addendum "FISCAL + COMPLIANCE + FRONTEIRA CONTÁBIL" do Caderno
 * Técnico. Reusa o schema "correspondent" (já tem GRANT concedido ao nayara_runtime desde a
 * migration 336 — PADRAO_COMPONENTES_E_REGRAS.md §2.4, evita abrir um schema novo só pra isso).
 *
 * Tabelas do Caderno (citação literal): "tax_documents; invoice_requests/events;
 * fiscal_obligations/calendar; accounting_export_batches/lines; accounting_return_imports;
 * dimob_records/batches; fiscal_reconciliations." — mapeadas 1:1 abaixo. "fiscal_calendar" não
 * vira tabela própria: é a MESMA tabela fiscal_obligations (due_at + status já é o calendário,
 * uma tabela separada só com datas seria dado derivado duplicado).
 *
 * Todas com RLS+FORCE RLS+policy tenant_isolation+GRANT explícito (lição da Fase 2: nunca confiar
 * em default privileges).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const sequelize = queryInterface.sequelize;

    const [[{ exists: runtimeExists }]] = await sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );

    async function rlsAndGrant(tableName) {
      await sequelize.query(`ALTER TABLE "correspondent"."${tableName}" ENABLE ROW LEVEL SECURITY;`);
      await sequelize.query(`ALTER TABLE "correspondent"."${tableName}" FORCE ROW LEVEL SECURITY;`);
      await sequelize.query(`
        CREATE POLICY tenant_isolation ON "correspondent"."${tableName}"
          USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
      `);
      if (runtimeExists) {
        await sequelize.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "correspondent"."${tableName}" TO nayara_runtime;`);
      }
    }

    const tenantCols = {
      group_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'groups', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      company_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'companies', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
    };

    // --- invoice_requests: ciclo REQUESTED→SUBMITTED→AUTHORIZED/REJECTED/CANCELED (NFS-e). ---
    await queryInterface.createTable(
      { tableName: 'invoice_requests', schema: 'correspondent' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
        ...tenantCols,
        source_type: { type: Sequelize.STRING(32), allowNull: false }, // ex: 'COMMISSION_ENTITLEMENT'
        source_id: { type: Sequelize.UUID, allowNull: false }, // referência genérica, nunca cópia de dado
        status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'REQUESTED' },
        adapter_version: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'sandbox-v1' },
        external_id: { type: Sequelize.STRING(128), allowNull: true },
        amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false },
        description: { type: Sequelize.TEXT, allowNull: false },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await rlsAndGrant('invoice_requests');
    await sequelize.query(`CREATE INDEX invoice_requests_source_idx ON "correspondent"."invoice_requests" (source_type, source_id);`);

    // --- invoice_events: histórico append-only (nunca UPDATE), mesmo espírito de ProviderStatusHistory. ---
    await queryInterface.createTable(
      { tableName: 'invoice_events', schema: 'correspondent' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
        ...tenantCols,
        invoice_request_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'invoice_requests', schema: 'correspondent' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
        },
        raw_status: { type: Sequelize.STRING(32), allowNull: false },
        normalized_status: { type: Sequelize.STRING(16), allowNull: true },
        occurred_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await rlsAndGrant('invoice_events');
    await sequelize.query(`CREATE INDEX invoice_events_request_idx ON "correspondent"."invoice_events" (invoice_request_id, occurred_at DESC);`);

    // tax_documents NÃO é criada aqui: já existe "finance"."tax_documents" desde a migration 057
    // (scaffold de documento fiscal NFS-e/DIMOB/comprovante de retenção, nunca consumido até
    // agora). Achado real corrigido via migration 351 (PADRAO_COMPONENTES_E_REGRAS.md §2.8): essa
    // tabela é ESTENDIDA com a coluna `invoice_request_id`, nunca duplicada.

    // --- fiscal_obligations: também cobre o "calendário" (due_at + status já é a agenda). ---
    await queryInterface.createTable(
      { tableName: 'fiscal_obligations', schema: 'correspondent' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
        ...tenantCols,
        obligation_type: { type: Sequelize.STRING(32), allowNull: false }, // ex: 'DIMOB_ANNUAL'
        reference_year: { type: Sequelize.INTEGER, allowNull: false },
        due_at: { type: Sequelize.DATEONLY, allowNull: false },
        status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'PENDING' },
        completed_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await rlsAndGrant('fiscal_obligations');
    await sequelize.query(`
      CREATE UNIQUE INDEX fiscal_obligations_unique ON "correspondent"."fiscal_obligations"
        (company_id, obligation_type, reference_year);
    `);

    // --- accounting_export_batches / lines: export por batch+hash, ajuste nunca edita linha original. ---
    await queryInterface.createTable(
      { tableName: 'accounting_export_batches', schema: 'correspondent' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
        ...tenantCols,
        reference_period: { type: Sequelize.STRING(7), allowNull: false }, // 'YYYY-MM'
        batch_hash: { type: Sequelize.STRING(64), allowNull: false },
        status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'EXPORTED' },
        created_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await rlsAndGrant('accounting_export_batches');

    await queryInterface.createTable(
      { tableName: 'accounting_export_lines', schema: 'correspondent' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
        ...tenantCols,
        batch_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'accounting_export_batches', schema: 'correspondent' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
        },
        source_type: { type: Sequelize.STRING(32), allowNull: false },
        source_id: { type: Sequelize.UUID, allowNull: false },
        amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false },
        description: { type: Sequelize.TEXT, allowNull: false },
        // Ajuste nunca edita a linha original — aponta pra ela e soma/subtrai (append-only, mesmo
        // padrão de chargeback de comissão da Fase 8).
        adjustment_of_line_id: {
          type: Sequelize.UUID, allowNull: true,
          references: { model: { tableName: 'accounting_export_lines', schema: 'correspondent' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await rlsAndGrant('accounting_export_lines');
    await sequelize.query(`CREATE INDEX accounting_export_lines_batch_idx ON "correspondent"."accounting_export_lines" (batch_id);`);

    // --- accounting_return_imports: retorno do contador importado (insumo de reconciliação). ---
    await queryInterface.createTable(
      { tableName: 'accounting_return_imports', schema: 'correspondent' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
        ...tenantCols,
        reference_period: { type: Sequelize.STRING(7), allowNull: false },
        file_name: { type: Sequelize.STRING(255), allowNull: true },
        summary_json: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
        imported_by: { type: Sequelize.UUID, allowNull: true },
        imported_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await rlsAndGrant('accounting_return_imports');

    // --- dimob_batches / records: dataset anual, snapshot/hash reproduzível, layout versionado. ---
    await queryInterface.createTable(
      { tableName: 'dimob_batches', schema: 'correspondent' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
        ...tenantCols,
        reference_year: { type: Sequelize.INTEGER, allowNull: false },
        layout_version: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'DIMOB-2026-v1' },
        version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
        status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'DRAFT' }, // DRAFT|CLOSED
        snapshot_hash: { type: Sequelize.STRING(64), allowNull: false },
        created_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await rlsAndGrant('dimob_batches');
    // Nunca sobrescreve um batch fechado — nova geração é uma VERSÃO nova, não um UPDATE.
    await sequelize.query(`
      CREATE UNIQUE INDEX dimob_batches_unique_version ON "correspondent"."dimob_batches"
        (company_id, reference_year, version);
    `);

    await queryInterface.createTable(
      { tableName: 'dimob_records', schema: 'correspondent' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
        ...tenantCols,
        dimob_batch_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'dimob_batches', schema: 'correspondent' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
        },
        source_refs: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} }, // nunca copia dado, só referencia
        amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await rlsAndGrant('dimob_records');
    await sequelize.query(`CREATE INDEX dimob_records_batch_idx ON "correspondent"."dimob_records" (dimob_batch_id);`);

    // --- fiscal_reconciliations: qualquer diferença encontrada abre registro, nunca é silenciosa. ---
    await queryInterface.createTable(
      { tableName: 'fiscal_reconciliations', schema: 'correspondent' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
        ...tenantCols,
        reconciliation_type: { type: Sequelize.STRING(32), allowNull: false }, // FINANCE_X_NFSE | COMMISSION_X_FISCAL | DIMOB_X_CONTRACTS
        reference_id: { type: Sequelize.UUID, allowNull: false },
        expected_amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false },
        actual_amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false },
        difference_amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false },
        status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'OPEN' },
        detected_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        resolved_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await rlsAndGrant('fiscal_reconciliations');
    await sequelize.query(`CREATE INDEX fiscal_reconciliations_type_idx ON "correspondent"."fiscal_reconciliations" (reconciliation_type, status);`);
  },

  down: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    const tables = [
      'fiscal_reconciliations',
      'dimob_records',
      'dimob_batches',
      'accounting_return_imports',
      'accounting_export_lines',
      'accounting_export_batches',
      'fiscal_obligations',
      'invoice_events',
      'invoice_requests',
    ];
    for (const t of tables) {
      await sequelize.query(`DROP POLICY IF EXISTS tenant_isolation ON "correspondent"."${t}";`);
      await queryInterface.dropTable({ tableName: t, schema: 'correspondent' });
    }
  },
};
