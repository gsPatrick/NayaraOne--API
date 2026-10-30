'use strict';

const { sequelize } = require('../../../models');

const SECRET_REF = 'MIGRATION_LEGACY_DB_URL';
const WATERMARK_REASON = 'A área de leitura do ERP antigo não expõe log de mudanças (sem LSN, binlog nem tabela de log com sequência monotônica); as tabelas de cadastro têm a coluna updated_at, então a carga é incremental por watermark.';

const PERSON_MAP = { id: 'sourceId', legal_name: 'legalName', preferred_name: 'preferredName', person_type: 'personType', tax_id: 'taxId', birth_date: 'birthDate' };
const PROPERTY_MAP = {
  id: 'sourceId', internal_code: 'internalCode', title: 'title', property_type: 'propertyType', address_line: 'addressLine', city: 'city', state: 'state', zip_code: 'zipCode',
  area_total_m2: 'areaTotalM2', bedrooms: 'bedrooms', parking_spots: 'parkingSpots', description: 'description',
};

/**
 * Fontes do sistema antigo (M9-D900 §3.1), semeadas sem rota de cadastro. O sistema antigo entrega os dados numa área de leitura (schema `legado`, somente leitura) com uma
 * tabela/visão por entidade e a chave em `id`; `columnMap` traduz as colunas dela para os campos canônicos do destino. A credencial é só o NOME da variável de ambiente (secret_ref).
 * Entidade nova entra aqui junto com o seu destino em ingest/targets.
 */
const SOURCE_SEEDS = Object.freeze([
  { sourceSystem: 'LEGADO_ERP', entity: 'PERSON', mode: 'WATERMARK', modeReason: WATERMARK_REASON, config: { connector: 'SQL', relation: 'legado.clientes', keyColumn: 'id', updatedAtColumn: 'updated_at', columnMap: PERSON_MAP } },
  { sourceSystem: 'LEGADO_ERP', entity: 'SUPPLIER', mode: 'WATERMARK', modeReason: WATERMARK_REASON, config: { connector: 'SQL', relation: 'legado.fornecedores', keyColumn: 'id', updatedAtColumn: 'updated_at', columnMap: PERSON_MAP } },
  { sourceSystem: 'LEGADO_ERP', entity: 'PROPERTY', mode: 'WATERMARK', modeReason: WATERMARK_REASON, config: { connector: 'SQL', relation: 'legado.imoveis', keyColumn: 'id', updatedAtColumn: 'updated_at', columnMap: PROPERTY_MAP } },
]);

/** Garante as fontes da empresa (idempotente; nunca sobrescreve o checkpoint nem o que o administrador de banco ajustou). */
async function ensureSeeded(tenant, transaction) {
  for (const seed of SOURCE_SEEDS) {
     
    await sequelize.query(
      `INSERT INTO governance.mig_sources (group_id, company_id, source_system, entity, mode, mode_reason, config, secret_ref)
       VALUES (:groupId, :companyId, :sourceSystem, :entity, :mode, :modeReason, CAST(:config AS jsonb), :secretRef) ON CONFLICT (company_id, source_system, entity) DO NOTHING`,
      { transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, ...seed, config: JSON.stringify(seed.config), secretRef: SECRET_REF } }
    );
  }
}

module.exports = { SOURCE_SEEDS, SECRET_REF, ensureSeeded };
