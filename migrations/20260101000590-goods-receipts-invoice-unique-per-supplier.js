'use strict';

/**
 * Revisão independente do Marco 7 (19/10/2026), item B11 — NF duplicada por FORNECEDOR.
 *
 * A unicidade de NF no recebimento de Compras era (company_id, invoice_fingerprint): a NF nº 123
 * de um fornecedor impedia registrar a NF nº 123 de outro (numeração de NF é por emitente). Passa a
 * ser (company_id, supplier_person_id, invoice_fingerprint). A coluna supplier_person_id é
 * preenchida a partir do pedido de compra de cada recebimento (backfill determinístico).
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "procurement"."goods_receipts" ADD COLUMN IF NOT EXISTS supplier_person_id UUID NULL;');
    await q(`
      UPDATE "procurement"."goods_receipts" gr
         SET supplier_person_id = po.supplier_person_id
        FROM "procurement"."purchase_orders" po
       WHERE po.id = gr.purchase_order_id
         AND gr.supplier_person_id IS NULL;
    `);
    await q('ALTER TABLE "procurement"."goods_receipts" DROP CONSTRAINT IF EXISTS goods_receipts_company_invoice_fingerprint_unique;');
    await q(`
      CREATE UNIQUE INDEX IF NOT EXISTS goods_receipts_company_supplier_invoice_unique
        ON "procurement"."goods_receipts" (company_id, supplier_person_id, invoice_fingerprint)
        WHERE invoice_fingerprint IS NOT NULL;
    `);

    const [[{ exists: runtimeExists }]] = await queryInterface.sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (runtimeExists) {
      await q('GRANT SELECT, INSERT, UPDATE ON "procurement"."goods_receipts" TO nayara_runtime;');
    }
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP INDEX IF EXISTS "procurement".goods_receipts_company_supplier_invoice_unique;');
    await q(`
      ALTER TABLE "procurement"."goods_receipts"
        ADD CONSTRAINT goods_receipts_company_invoice_fingerprint_unique UNIQUE (company_id, invoice_fingerprint);
    `);
    await q('ALTER TABLE "procurement"."goods_receipts" DROP COLUMN IF EXISTS supplier_person_id;');
  },
};
