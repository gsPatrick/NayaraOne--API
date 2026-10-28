'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { sanitizePublicFields } = require('./sanitize');
const { readPublicFieldsConfig } = require('./publicFields.settings');

/**
 * M9-D403 — Read models públicos. O serviço de conteúdo lê SOMENTE as visões marketing.v_public_property,
 * marketing.v_public_construction e marketing.v_relationship_facts (nunca as tabelas de origem; o teste estático do CI confere
 * esta pasta). As visões têm security_invoker: herdam a RLS do imóvel, da obra e da pessoa, e ainda filtramos por empresa.
 * A política de endereço já foi aplicada no SQL da visão; aqui ela é aplicada de novo pelo sanitizePublicFields (defesa em
 * profundidade) com a allowlist e as características permitidas da empresa (configuração).
 */

const num = (v) => (v === null || v === undefined ? null : Number(v));
const iso = (v) => (v === null || v === undefined ? null : new Date(v).toISOString());

function propertyRowToPayload(r) {
  return {
    publicId: r.public_id,
    tipo: r.tipo,
    finalidade: r.finalidade,
    bairro: r.bairro,
    cidade: r.cidade,
    uf: r.uf,
    logradouro: r.logradouro,
    numeroEndereco: r.numero_endereco,
    quartos: r.quartos,
    suites: r.suites,
    banheiros: r.banheiros,
    vagas: r.vagas,
    areaUtilM2: num(r.area_util_m2),
    areaTotalM2: num(r.area_total_m2),
    precoVenda: num(r.preco_venda),
    precoLocacao: num(r.preco_locacao),
    precoAnterior: num(r.preco_anterior),
    condominio: num(r.condominio),
    iptu: num(r.iptu),
    features: r.features || [],
    fotosAutorizadas: r.fotos_autorizadas || [],
    publicadoEm: iso(r.publicado_em),
  };
}

function constructionRowToPayload(r) {
  return {
    nomeEmpreendimento: r.nome_empreendimento,
    etapaPublica: r.etapa_publica,
    fotosAutorizadas: r.fotos_autorizadas || [],
    publicadoEm: iso(r.publicado_em),
  };
}

function requireCompany(tenant) {
  if (!tenant || !tenant.companyId) {
    throw AppError.badRequest('O contexto de empresa é obrigatório.', 'MKT_TENANT_REQUIRED');
  }
}

async function readOne(sql, replacements, transaction) {
  const rows = await sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });
  return rows[0] || null;
}

async function finish(raw, policy, tenant, transaction, extra) {
  const config = await readPublicFieldsConfig(tenant, transaction);
  const report = sanitizePublicFields(raw, policy, config);
  return { payload: report.payload, policy: report.policy, removedKeys: report.removedKeys, redactedPatterns: report.redactedPatterns, ...extra };
}

/** PublicPropertyReadModel de um imóvel (por id interno OU por publicId), já sanitizado. `sourceVersion` = lock_version do imóvel. */
async function loadPublicProperty({ propertyId, publicId }, tenant, transaction) {
  requireCompany(tenant);
  if (!propertyId && !publicId) throw AppError.badRequest('Informe o imóvel.', 'MKT_SOURCE_REQUIRED');
  const row = await readOne(
    `SELECT * FROM marketing.v_public_property WHERE company_id = :companyId AND ${propertyId ? 'property_id = :key' : 'public_id = :key'}`,
    { companyId: tenant.companyId, key: propertyId || publicId },
    transaction
  );
  if (!row) throw AppError.notFound('O imóvel não está disponível para conteúdo público.', 'MKT_SOURCE_NOT_FOUND');
  return finish(propertyRowToPayload(row), row.politica_endereco, tenant, transaction, { sourceVersion: row.source_version });
}

/** Read model público de um empreendimento (obra com etapa marcada como publicável), já sanitizado. */
async function loadPublicConstruction({ projectId }, tenant, transaction) {
  requireCompany(tenant);
  const row = await readOne(
    'SELECT * FROM marketing.v_public_construction WHERE company_id = :companyId AND project_id = :projectId',
    { companyId: tenant.companyId, projectId },
    transaction
  );
  if (!row) throw AppError.notFound('A obra não tem etapa publicável.', 'MKT_SOURCE_NOT_FOUND');
  return finish(constructionRowToPayload(row), null, tenant, transaction, { sourceVersion: null });
}

/**
 * Fatos de relacionamento (primeiro nome, marco, dia e mês). DADO PESSOAL: só para canal privado sujeito a canSend (M9-D409);
 * nunca passa pelo caminho público e nunca entra em rede social, site ou portal. Por isso não há sanitização de allowlist aqui.
 */
async function loadRelationshipFacts({ personId, marco }, tenant, transaction) {
  requireCompany(tenant);
  const rows = await sequelize.query(
    `SELECT person_id, primeiro_nome, marco, dia, mes, data_marco FROM marketing.v_relationship_facts
      WHERE company_id = :companyId AND person_id = :personId AND (:marco::text IS NULL OR marco = :marco)
      ORDER BY marco, data_marco NULLS FIRST`,
    { replacements: { companyId: tenant.companyId, personId, marco: marco || null }, transaction, type: QueryTypes.SELECT }
  );
  return rows.map((r) => ({
    personId: r.person_id, primeiroNome: r.primeiro_nome, marco: r.marco, dia: r.dia, mes: r.mes, dataMarco: r.data_marco,
  }));
}

module.exports = { loadPublicProperty, loadPublicConstruction, loadRelationshipFacts, propertyRowToPayload, constructionRowToPayload };
