'use strict';

/**
 * Migration (M3-13 / M3-25): cria "crm"."proposals" — entidade REAL de proposta, separada da
 * Opportunity. Até aqui o sistema não tinha nenhuma noção de proposta: o valor negociado
 * vivia em `opportunities.expected_value`, um campo único sobrescrito a cada
 * contraproposta — ou seja, o histórico de negociação era destruído a cada rodada.
 *
 * DECISÕES DE MODELAGEM:
 *  - APPEND-ONLY POR VERSÃO: cada nova proposta para o mesmo (opportunity_id, property_id) é
 *    uma NOVA LINHA com `version_number` incrementado, nunca um UPDATE destrutivo do `value`.
 *    O índice único (opportunity_id, property_id, version_number) garante isso no banco.
 *    `property_id` é opcional (proposta pode existir antes de o imóvel estar definido); no
 *    índice único o NULL é normalizado via COALESCE numa coluna gerada não seria possível sem
 *    complicar — usamos um índice único parcial para cada caso (com e sem property).
 *  - `status` muda ao longo do tempo (DRAFT -> SENT -> ... -> ACCEPTED/REJECTED/EXPIRED);
 *    só o status (e campos de decisão) é mutável. `value` é imutável depois de SENT —
 *    regra aplicada em proposals.service.js.
 *  - `paranoid` (deleted_at) para manter o mesmo padrão das demais tabelas de CRM.
 *
 * RLS completo (ENABLE + FORCE + policy tenant_isolation por company_id), igual ao padrão de
 * toda tabela multiempresa do projeto.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'proposals', schema: 'crm' },
      {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
          allowNull: false,
        },
        group_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'groups', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        company_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'companies', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        opportunity_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'opportunities', schema: 'crm' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        property_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'properties', schema: 'real_estate' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        proposed_by_person_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'persons', schema: 'people' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
          comment: 'Pessoa (comprador/locatário) que fez a proposta.',
        },
        value: {
          type: Sequelize.DECIMAL(18, 2),
          allowNull: false,
          comment: 'Valor proposto. Imutável depois que a proposta sai de DRAFT — nova negociação = nova versão.',
        },
        currency: {
          type: Sequelize.STRING(3),
          allowNull: false,
          defaultValue: 'BRL',
        },
        status: {
          type: Sequelize.STRING(24),
          allowNull: false,
          defaultValue: 'DRAFT',
          comment: 'DRAFT|SENT|UNDER_NEGOTIATION|ACCEPTED|REJECTED|EXPIRED',
        },
        version_number: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 1,
          comment: 'Versão da proposta dentro do par (opportunity_id, property_id) — append-only.',
        },
        notes: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        valid_until: {
          type: Sequelize.DATE,
          allowNull: true,
        },
        sent_at: { type: Sequelize.DATE, allowNull: true },
        decided_at: {
          type: Sequelize.DATE,
          allowNull: true,
          comment: 'Quando a proposta foi ACCEPTED/REJECTED/EXPIRED.',
        },
        decided_by_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
        lock_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        deleted_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        deleted_at: { type: Sequelize.DATE, allowNull: true },
      }
    );

    await queryInterface.addIndex({ tableName: 'proposals', schema: 'crm' }, ['opportunity_id'], {
      name: 'crm_proposals_opportunity_id_idx',
    });
    await queryInterface.addIndex({ tableName: 'proposals', schema: 'crm' }, ['status'], {
      name: 'crm_proposals_status_idx',
    });

    // Append-only por versão: não pode existir duas linhas com a mesma versão pro mesmo
    // (opportunity, property). Dois índices parciais porque NULL não colide em UNIQUE.
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX crm_proposals_version_with_property_uidx
        ON "crm"."proposals" (opportunity_id, property_id, version_number)
        WHERE deleted_at IS NULL AND property_id IS NOT NULL;
    `);
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX crm_proposals_version_no_property_uidx
        ON "crm"."proposals" (opportunity_id, version_number)
        WHERE deleted_at IS NULL AND property_id IS NULL;
    `);

    await queryInterface.sequelize.query('ALTER TABLE "crm"."proposals" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "crm"."proposals" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "crm"."proposals"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "crm"."proposals";');
    await queryInterface.sequelize.query('ALTER TABLE "crm"."proposals" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'proposals', schema: 'crm' });
  },
};
