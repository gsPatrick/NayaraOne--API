'use strict';

const crypto = require('crypto');
const { Cart, CartVersion, CartShareRouting, Opportunity, Property, PropertyOffer, PropertyMedia } = require('../../models');
const AppError = require('../../utils/AppError');
const { publishDomainEvent } = require('../../engines/events/outbox');

/**
 * carts.service.js — item 3 do ciclo de auditoria externa Marco 3 ("crm.carts — não existe
 * NADA hoje").
 *
 * Contrato bruto confirmado (Guia do Marcelo §14 "Carrinho de imóveis"):
 *   "Usuário seleciona imóveis de uma oportunidade."
 *   "Gera link/coleção com expiração e tracking."
 *   "Não expõe observações internas nem endereço sensível."
 *   "Visualização/clique podem gerar eventos para CRM."
 *   "Carrinho versionado para saber o que foi enviado."
 *
 * Tabelas (migration 20260101000286-create-crm-carts.js — RLS ENABLE+FORCE+policy
 * tenant_isolation em crm.carts/crm.cart_versions, mesmo padrão de toda tabela multiempresa do
 * projeto; crm.cart_share_routing é exceção deliberada SEM RLS, mesmo princípio de
 * SignatureProviderRouting, pois o visitante do link público não tem tenant/JWT nenhum).
 */

const DEFAULT_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

async function createCart(opportunityId, payload, actorUserId, transaction) {
  const { propertyIds, expiresAt } = payload || {};
  if (!opportunityId) {
    throw AppError.badRequest('O campo "opportunityId" é obrigatório.', 'CART_VALIDATION');
  }
  if (!Array.isArray(propertyIds) || propertyIds.length === 0) {
    throw AppError.badRequest('O campo "propertyIds" deve ser uma lista não vazia.', 'CART_VALIDATION');
  }

  const opportunity = await Opportunity.findByPk(opportunityId, { transaction });
  if (!opportunity) throw AppError.notFound('Oportunidade não encontrada.', 'OPPORTUNITY_NOT_FOUND');

  const properties = await Property.findAll({ where: { id: propertyIds }, transaction });
  if (properties.length !== propertyIds.length) {
    throw AppError.badRequest('Um ou mais imóveis informados não foram encontrados.', 'CART_VALIDATION');
  }

  const cart = await Cart.create(
    {
      groupId: opportunity.groupId,
      companyId: opportunity.companyId,
      opportunityId,
      currentVersion: 1,
      status: 'ACTIVE',
      expiresAt: expiresAt ? new Date(expiresAt) : new Date(Date.now() + DEFAULT_EXPIRATION_MS),
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await CartVersion.create(
    {
      groupId: cart.groupId,
      companyId: cart.companyId,
      cartId: cart.id,
      versionNumber: 1,
      propertyIdsJson: propertyIds,
      createdBy: actorUserId || null,
    },
    { transaction }
  );

  return cart;
}

/**
 * updateCartItems — "Carrinho versionado para saber o que foi enviado": qualquer mudança na
 * lista de imóveis cria uma NOVA versão (nunca sobrescreve a anterior), preservando o que já
 * foi visto/enviado em versões anteriores.
 */
async function updateCartItems(cartId, propertyIds, actorUserId, transaction) {
  if (!Array.isArray(propertyIds) || propertyIds.length === 0) {
    throw AppError.badRequest('O campo "propertyIds" deve ser uma lista não vazia.', 'CART_VALIDATION');
  }
  const cart = await Cart.findByPk(cartId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!cart) throw AppError.notFound('Carrinho não encontrado.', 'CART_NOT_FOUND');

  const properties = await Property.findAll({ where: { id: propertyIds }, transaction });
  if (properties.length !== propertyIds.length) {
    throw AppError.badRequest('Um ou mais imóveis informados não foram encontrados.', 'CART_VALIDATION');
  }

  const nextVersion = cart.currentVersion + 1;
  await CartVersion.create(
    {
      groupId: cart.groupId,
      companyId: cart.companyId,
      cartId: cart.id,
      versionNumber: nextVersion,
      propertyIdsJson: propertyIds,
      createdBy: actorUserId || null,
    },
    { transaction }
  );

  cart.currentVersion = nextVersion;
  cart.updatedBy = actorUserId || null;
  await cart.save({ transaction });

  return cart;
}

/**
 * generateShareLink — "Gera link/coleção com expiração e tracking." Cria (ou reaproveita) um
 * token opaco em crm.cart_share_routing (SEM RLS — ver cabeçalho do módulo), único por
 * carrinho, para que o endpoint público resolva o tenant ANTES de abrir a transação com SET
 * LOCAL (mesmo padrão de clicksignPublicWebhook).
 */
async function generateShareLink(cartId, transaction) {
  const cart = await Cart.findByPk(cartId, { transaction });
  if (!cart) throw AppError.notFound('Carrinho não encontrado.', 'CART_NOT_FOUND');

  const existing = await CartShareRouting.findOne({ where: { cartId }, transaction });
  if (existing) return existing;

  const token = crypto.randomBytes(24).toString('hex');
  return CartShareRouting.create(
    { token, cartId: cart.id, groupId: cart.groupId, companyId: cart.companyId },
    { transaction }
  );
}

/**
 * sanitizePropertyForPublicCart — "Não expõe observações internas nem endereço sensível."
 * Allowlist explícita de campos públicos — NUNCA um blocklist (evita vazar um campo novo
 * sensível adicionado no futuro por omissão). Nunca inclui property_internal_occurrences,
 * registry_number/registry_office, address_line/zip_code completos, nem confidential_min_price.
 */
function sanitizePropertyForPublicCart(property, activeOffer, approvedMedia) {
  return {
    id: property.id,
    title: property.title,
    propertyType: property.propertyType,
    city: property.city,
    state: property.state,
    bedrooms: property.bedrooms,
    parkingSpots: property.parkingSpots,
    areaTotalM2: property.areaTotalM2,
    offer: activeOffer
      ? {
          offerType: activeOffer.offerType,
          askingPrice: activeOffer.askingPrice,
          acceptsFinancing: activeOffer.acceptsFinancing,
        }
      : null,
    photos: approvedMedia.map((m) => ({ id: m.id, position: m.position })),
  };
}

/**
 * getPublicCartByToken — endpoint PÚBLICO (sem auth), resolve o tenant via
 * CartShareRouting (sem RLS) e SÓ DEPOIS abre a transação com SET LOCAL para consultar o
 * carrinho (que tem RLS normal). Registra o evento `crm.cart.viewed` ("Visualização/clique
 * podem gerar eventos para CRM.") na MESMA transação.
 */
async function getPublicCartByToken(token, sequelize) {
  const routing = await CartShareRouting.findOne({ where: { token } });
  if (!routing) {
    throw AppError.notFound('Link de carrinho inválido ou expirado.', 'CART_SHARE_LINK_NOT_FOUND');
  }

  return sequelize.transaction(async (t) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: routing.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: routing.companyId }, transaction: t });

    const cart = await Cart.findByPk(routing.cartId, { transaction: t });
    if (!cart) throw AppError.notFound('Carrinho não encontrado.', 'CART_NOT_FOUND');

    if (cart.status !== 'ACTIVE' || new Date(cart.expiresAt) < new Date()) {
      throw AppError.unprocessable('Este link de carrinho expirou ou foi revogado.', 'CART_SHARE_LINK_EXPIRED');
    }

    const version = await CartVersion.findOne({
      where: { cartId: cart.id, versionNumber: cart.currentVersion },
      transaction: t,
    });

    const propertyIds = version ? version.propertyIdsJson : [];
    const properties = await Property.findAll({ where: { id: propertyIds }, transaction: t });

    const sanitizedProperties = [];
    for (const property of properties) {
      // eslint-disable-next-line no-await-in-loop
      const activeOffer = await PropertyOffer.findOne({ where: { propertyId: property.id, status: 'ACTIVE' }, transaction: t });
      // eslint-disable-next-line no-await-in-loop
      const approvedMedia = await PropertyMedia.findAll({
        where: { propertyId: property.id, mediaType: 'PHOTO', qualityStatus: 'APPROVED' },
        transaction: t,
      });
      sanitizedProperties.push(sanitizePropertyForPublicCart(property, activeOffer, approvedMedia));
    }

    await publishDomainEvent(
      {
        groupId: cart.groupId,
        companyId: cart.companyId,
        aggregateType: 'Cart',
        aggregateId: cart.id,
        eventType: 'crm.cart.viewed',
        payload: { cartId: cart.id, version: cart.currentVersion },
        idempotencyKey: `crm.cart.viewed:${cart.id}:${cart.currentVersion}:${Date.now()}`,
      },
      t
    );

    return { cartId: cart.id, version: cart.currentVersion, expiresAt: cart.expiresAt, properties: sanitizedProperties };
  });
}

/**
 * recordPublicCartClick — "Visualização/clique podem gerar eventos para CRM." Clique em um
 * imóvel específico dentro do carrinho público.
 */
async function recordPublicCartClick(token, propertyId, sequelize) {
  const routing = await CartShareRouting.findOne({ where: { token } });
  if (!routing) {
    throw AppError.notFound('Link de carrinho inválido ou expirado.', 'CART_SHARE_LINK_NOT_FOUND');
  }

  return sequelize.transaction(async (t) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: routing.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: routing.companyId }, transaction: t });

    const cart = await Cart.findByPk(routing.cartId, { transaction: t });
    if (!cart) throw AppError.notFound('Carrinho não encontrado.', 'CART_NOT_FOUND');

    await publishDomainEvent(
      {
        groupId: cart.groupId,
        companyId: cart.companyId,
        aggregateType: 'Cart',
        aggregateId: cart.id,
        eventType: 'crm.cart.property_clicked',
        payload: { cartId: cart.id, propertyId, version: cart.currentVersion },
        idempotencyKey: `crm.cart.property_clicked:${cart.id}:${propertyId}:${Date.now()}`,
      },
      t
    );

    return { acknowledged: true };
  });
}

module.exports = {
  createCart,
  updateCartItems,
  generateShareLink,
  getPublicCartByToken,
  recordPublicCartClick,
  sanitizePropertyForPublicCart,
};
