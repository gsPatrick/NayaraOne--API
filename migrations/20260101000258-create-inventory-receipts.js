'use strict';

/**
 * Migration: Marco 7 fase 3 (Guia do Marcelo) — "receipts/NF": recebimento de material
 * vinculado a nota fiscal/fornecedor. invoice_fingerprint é UNIQUE por empresa para detectar
 * NF duplicada antes de confirmar (EST-TS-08). supplier_person_id/invoice_file_id ficam sem FK
 * (mesmo padrão já usado em daily_reports.evidence_file_ids) — People/Files são módulos
 * separados e a regra geral do projeto é não acoplar FK cross-módulo quando a referência é
 * apenas informativa/de evidência.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'receipts', schema: 'inventory' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
        group_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'groups', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        company_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'companies', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        destination_location_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'locations', schema: 'inventory' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        supplier_person_id: { type: Sequelize.UUID, allowNull: true },
        invoice_number: { type: Sequelize.STRING(64), allowNull: true },
        invoice_fingerprint: { type: Sequelize.STRING(128), allowNull: true, comment: 'Hash/chave da NF — detecta duplicidade (EST-TS-08).' },
        invoice_file_id: { type: Sequelize.UUID, allowNull: true },
        status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'DRAFT', comment: 'DRAFT|REVIEWED|COMPLETED' },
        notes: { type: Sequelize.TEXT, allowNull: true },
        lock_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await queryInterface.addConstraint({ tableName: 'receipts', schema: 'inventory' }, {
      fields: ['company_id', 'invoice_fingerprint'],
      type: 'unique',
      name: 'receipts_company_invoice_fingerprint_unique',
    });
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."receipts" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."receipts" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "inventory"."receipts"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);

    await queryInterface.createTable(
      { tableName: 'receipt_items', schema: 'inventory' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
        group_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'groups', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        company_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'companies', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        receipt_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'receipts', schema: 'inventory' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
        },
        inventory_item_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'inventory_items', schema: 'inventory' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        quantity: { type: Sequelize.DECIMAL(14, 6), allowNull: false },
        unit_cost: { type: Sequelize.DECIMAL(18, 6), allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."receipt_items" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."receipt_items" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "inventory"."receipt_items"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "inventory"."receipt_items";');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."receipt_items" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'receipt_items', schema: 'inventory' });

    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "inventory"."receipts";');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."receipts" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'receipts', schema: 'inventory' });
  },
};
