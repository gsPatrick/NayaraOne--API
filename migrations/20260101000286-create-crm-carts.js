'use strict';

/**
 * Migration: cria "crm"."carts" — item 3 do ciclo de auditoria externa Marco 3.
 *
 * Contrato bruto confirmado (Guia do Marcelo §14 "Carrinho de imóveis"):
 *   "Usuário seleciona imóveis de uma oportunidade."
 *   "Gera link/coleção com expiração e tracking."
 *   "Não expõe observações internas nem endereço sensível."
 *   "Visualização/clique podem gerar eventos para CRM."
 *   "Carrinho versionado para saber o que foi enviado."
 * E o catálogo físico (Caderno Pessoas/Imóveis/CRM/Radar) já lista
 * "crm.carts — Carrinho de imóveis compartilhável." entre as tabelas do domínio.
 *
 * Mesmo padrão DB-002/DB-BLIND-002 de toda tabela multiempresa: RLS ENABLE + FORCE +
 * policy tenant_isolation deny-by-default (ver create-crm-opportunities/messages).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'carts', schema: 'crm' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
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
        // "Carrinho versionado para saber o que foi enviado": current_version aponta para a
        // linha mais recente em crm.cart_versions (histórico append-only — nunca sobrescrito).
        current_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
        status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'ACTIVE', comment: 'ACTIVE|EXPIRED|REVOKED' },
        expires_at: { type: Sequelize.DATE, allowNull: false },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.sequelize.query('ALTER TABLE "crm"."carts" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "crm"."carts" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "crm"."carts"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);

    // crm.cart_versions — snapshot append-only de cada versão do carrinho (lista de imóveis
    // daquela versão). Nunca é alterado depois de criado; uma mudança no carrinho cria uma
    // NOVA linha com version_number incrementado, preservando o que já foi visto/enviado.
    await queryInterface.createTable(
      { tableName: 'cart_versions', schema: 'crm' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
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
        cart_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'carts', schema: 'crm' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        version_number: { type: Sequelize.INTEGER, allowNull: false },
        property_ids_json: { type: Sequelize.JSONB, allowNull: false },
        created_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await queryInterface.addConstraint(
      { tableName: 'cart_versions', schema: 'crm' },
      { fields: ['cart_id', 'version_number'], type: 'unique', name: 'cart_versions_cart_id_version_number_unique' }
    );

    await queryInterface.sequelize.query('ALTER TABLE "crm"."cart_versions" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "crm"."cart_versions" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "crm"."cart_versions"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);

    // crm.cart_share_routing — EXCEÇÃO DELIBERADA, mesmo princípio de
    // legal.signature_provider_routing / finance.bank_payment_provider_routing: o visitante do
    // link público não tem JWT/tenant nenhum. Guarda só um token opaco -> (group_id,
    // company_id, cart_id), SEM RLS — o controller público resolve o tenant aqui e SÓ DEPOIS
    // abre a transação com SET LOCAL para consultar crm.carts/cart_versions (que têm RLS
    // normal).
    await queryInterface.createTable(
      { tableName: 'cart_share_routing', schema: 'crm' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
        token: { type: Sequelize.STRING(128), allowNull: false, unique: true },
        cart_id: { type: Sequelize.UUID, allowNull: false },
        group_id: { type: Sequelize.UUID, allowNull: false },
        company_id: { type: Sequelize.UUID, allowNull: false },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      }
    );
    await queryInterface.addIndex(
      { tableName: 'cart_share_routing', schema: 'crm' },
      ['cart_id'],
      { name: 'cart_share_routing_cart_id_idx' }
    );
    // Deliberadamente SEM ENABLE ROW LEVEL SECURITY — ver comentário acima.
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable({ tableName: 'cart_share_routing', schema: 'crm' });
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "crm"."cart_versions";');
    await queryInterface.sequelize.query('ALTER TABLE "crm"."cart_versions" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'cart_versions', schema: 'crm' });
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "crm"."carts";');
    await queryInterface.sequelize.query('ALTER TABLE "crm"."carts" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'carts', schema: 'crm' });
  },
};
