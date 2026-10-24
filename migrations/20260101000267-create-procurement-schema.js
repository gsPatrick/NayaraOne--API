'use strict';

/**
 * Migration: Marco 7 fase 11 (Caderno "COMPRAS/PROCUREMENT") — schema novo "procurement",
 * fluxo REQUEST->APPROVAL->RFQ->COMPARISON->AWARD->PO->RECEIPT->MATCH->PAYABLE.
 * supplier_person_id referencia "people"."persons" (fornecedor é uma Person com papel
 * SUPPLIER, mesmo cadastro mestre usado pelo resto do sistema — não um cadastro de fornecedor
 * paralelo).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query('CREATE SCHEMA IF NOT EXISTS "procurement";');

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

    // purchase_requests / purchase_request_items
    await queryInterface.createTable({ tableName: 'purchase_requests', schema: 'procurement' }, tenantCols({
      project_id: {
        type: Sequelize.UUID, allowNull: true,
        references: { model: { tableName: 'projects', schema: 'construction' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'REQUESTED', comment: 'REQUESTED|APPROVED|REJECTED|AWARDED|CLOSED' },
      requested_by_user_id: { type: Sequelize.UUID, allowNull: true },
      approved_by_user_id: { type: Sequelize.UUID, allowNull: true },
      notes: { type: Sequelize.TEXT, allowNull: true },
      lock_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_by: { type: Sequelize.UUID, allowNull: true },
      updated_by: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    }));
    await enableRls('purchase_requests');

    await queryInterface.createTable({ tableName: 'purchase_request_items', schema: 'procurement' }, tenantCols({
      purchase_request_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'purchase_requests', schema: 'procurement' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      inventory_item_id: {
        type: Sequelize.UUID, allowNull: true,
        references: { model: { tableName: 'inventory_items', schema: 'inventory' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      description: { type: Sequelize.STRING(255), allowNull: false },
      quantity: { type: Sequelize.DECIMAL(14, 6), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    }));
    await enableRls('purchase_request_items');

    // quotations (RFQ) / supplier_offers / supplier_offer_items
    await queryInterface.createTable({ tableName: 'quotations', schema: 'procurement' }, tenantCols({
      purchase_request_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'purchase_requests', schema: 'procurement' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'OPEN', comment: 'OPEN|CLOSED' },
      created_by: { type: Sequelize.UUID, allowNull: true },
      updated_by: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    }));
    await enableRls('quotations');

    await queryInterface.createTable({ tableName: 'supplier_offers', schema: 'procurement' }, tenantCols({
      quotation_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'quotations', schema: 'procurement' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      supplier_person_id: { type: Sequelize.UUID, allowNull: false },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'RECEIVED', comment: 'RECEIVED|AWARDED|REJECTED' },
      total_amount: { type: Sequelize.DECIMAL(18, 2), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    }));
    await enableRls('supplier_offers');

    await queryInterface.createTable({ tableName: 'supplier_offer_items', schema: 'procurement' }, tenantCols({
      supplier_offer_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'supplier_offers', schema: 'procurement' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      purchase_request_item_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'purchase_request_items', schema: 'procurement' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      unit_price: { type: Sequelize.DECIMAL(18, 6), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    }));
    await enableRls('supplier_offer_items');

    // purchase_orders / purchase_order_items
    await queryInterface.createTable({ tableName: 'purchase_orders', schema: 'procurement' }, tenantCols({
      purchase_request_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'purchase_requests', schema: 'procurement' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      supplier_offer_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'supplier_offers', schema: 'procurement' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      supplier_person_id: { type: Sequelize.UUID, allowNull: false },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'OPEN', comment: 'OPEN|RECEIVED|CANCELED' },
      committed_amount: { type: Sequelize.DECIMAL(18, 2), allowNull: false },
      lock_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_by: { type: Sequelize.UUID, allowNull: true },
      updated_by: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    }));
    await enableRls('purchase_orders');

    await queryInterface.createTable({ tableName: 'purchase_order_items', schema: 'procurement' }, tenantCols({
      purchase_order_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'purchase_orders', schema: 'procurement' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      inventory_item_id: {
        type: Sequelize.UUID, allowNull: true,
        references: { model: { tableName: 'inventory_items', schema: 'inventory' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      description: { type: Sequelize.STRING(255), allowNull: false },
      quantity: { type: Sequelize.DECIMAL(14, 6), allowNull: false },
      unit_price: { type: Sequelize.DECIMAL(18, 6), allowNull: false },
      received_quantity: { type: Sequelize.DECIMAL(14, 6), allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    }));
    await enableRls('purchase_order_items');

    // goods_receipts / receipt_discrepancies
    await queryInterface.createTable({ tableName: 'goods_receipts', schema: 'procurement' }, tenantCols({
      purchase_order_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'purchase_orders', schema: 'procurement' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      destination_location_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'locations', schema: 'inventory' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      inventory_receipt_id: {
        type: Sequelize.UUID, allowNull: true,
        references: { model: { tableName: 'receipts', schema: 'inventory' }, key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
      },
      invoice_fingerprint: { type: Sequelize.STRING(128), allowNull: true },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'DRAFT', comment: 'DRAFT|CONFIRMED' },
      created_by: { type: Sequelize.UUID, allowNull: true },
      updated_by: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    }));
    await queryInterface.addConstraint({ tableName: 'goods_receipts', schema: 'procurement' }, {
      fields: ['company_id', 'invoice_fingerprint'],
      type: 'unique',
      name: 'goods_receipts_company_invoice_fingerprint_unique',
    });
    await enableRls('goods_receipts');

    await queryInterface.createTable({ tableName: 'goods_receipt_items', schema: 'procurement' }, tenantCols({
      goods_receipt_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'goods_receipts', schema: 'procurement' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      purchase_order_item_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'purchase_order_items', schema: 'procurement' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      received_quantity: { type: Sequelize.DECIMAL(14, 6), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    }));
    await enableRls('goods_receipt_items');

    await queryInterface.createTable({ tableName: 'receipt_discrepancies', schema: 'procurement' }, tenantCols({
      goods_receipt_item_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'goods_receipt_items', schema: 'procurement' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
      },
      discrepancy_type: { type: Sequelize.STRING(32), allowNull: false, comment: 'OVER_RECEIPT|UNDER_RECEIPT|PRICE_MISMATCH' },
      expected_value: { type: Sequelize.DECIMAL(18, 6), allowNull: true },
      received_value: { type: Sequelize.DECIMAL(18, 6), allowNull: true },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'OPEN', comment: 'OPEN|RESOLVED' },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    }));
    await enableRls('receipt_discrepancies');

    // supplier_evaluations
    await queryInterface.createTable({ tableName: 'supplier_evaluations', schema: 'procurement' }, tenantCols({
      supplier_person_id: { type: Sequelize.UUID, allowNull: false },
      purchase_order_id: {
        type: Sequelize.UUID, allowNull: true,
        references: { model: { tableName: 'purchase_orders', schema: 'procurement' }, key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
      },
      score: { type: Sequelize.INTEGER, allowNull: false, comment: '1 a 5.' },
      notes: { type: Sequelize.TEXT, allowNull: true },
      created_by: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    }));
    await queryInterface.sequelize.query(`
      ALTER TABLE "procurement"."supplier_evaluations" ADD CONSTRAINT supplier_evaluations_score_check CHECK (score BETWEEN 1 AND 5);
    `);
    await enableRls('supplier_evaluations');
  },

  down: async (queryInterface) => {
    const dropWithPolicy = async (table) => {
      await queryInterface.sequelize.query(`DROP POLICY IF EXISTS tenant_isolation ON "procurement"."${table}";`);
      await queryInterface.sequelize.query(`ALTER TABLE "procurement"."${table}" DISABLE ROW LEVEL SECURITY;`);
      await queryInterface.dropTable({ tableName: table, schema: 'procurement' });
    };
    await dropWithPolicy('supplier_evaluations');
    await dropWithPolicy('receipt_discrepancies');
    await dropWithPolicy('goods_receipt_items');
    await dropWithPolicy('goods_receipts');
    await dropWithPolicy('purchase_order_items');
    await dropWithPolicy('purchase_orders');
    await dropWithPolicy('supplier_offer_items');
    await dropWithPolicy('supplier_offers');
    await dropWithPolicy('quotations');
    await dropWithPolicy('purchase_request_items');
    await dropWithPolicy('purchase_requests');
  },
};
