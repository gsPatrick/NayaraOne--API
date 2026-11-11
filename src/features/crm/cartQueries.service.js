'use strict';

const { Cart, CartVersion, CartShareRouting, Opportunity, Property } = require('../../models');
const AppError = require('../../utils/AppError');
const { summarizeCartEvents } = require('./cartTracking.service');

/**
 * Leitura dos carrinhos de uma oportunidade para a tela do carrinho (livro do Marco 3 §14; verificação de 11/11/2026: "não há
 * tela de carrinho no Front"). GET /opportunities/:id/carts — a rota fica sob a guarda de carteira de /opportunities/:id.
 * Devolve cada carrinho com o status efetivo (EXPIRED quando passou da validade), todas as versões (o que foi enviado em cada
 * uma, com o nome dos imóveis), o link gerado e o rastreio (visualizações e cliques por imóvel).
 */
function effectiveStatus(cart, now = new Date()) {
  if (cart.status !== 'ACTIVE') return cart.status;
  return new Date(cart.expiresAt) < now ? 'EXPIRED' : 'ACTIVE';
}

async function listOpportunityCarts(opportunityId, transaction) {
  const opportunity = await Opportunity.findByPk(opportunityId, { transaction });
  if (!opportunity) throw AppError.notFound('Oportunidade não encontrada.', 'OPPORTUNITY_NOT_FOUND');
  const carts = await Cart.findAll({ where: { opportunityId }, order: [['created_at', 'DESC']], transaction });
  const cartIds = carts.map((c) => c.id);
  if (cartIds.length === 0) return [];

  const versions = await CartVersion.findAll({ where: { cartId: cartIds }, order: [['version_number', 'ASC']], transaction });
  const links = await CartShareRouting.findAll({ where: { cartId: cartIds }, transaction });
  const propertyIds = [...new Set(versions.flatMap((v) => v.propertyIdsJson || []))];
  const properties = propertyIds.length
    ? await Property.findAll({ where: { id: propertyIds }, attributes: ['id', 'title', 'internalCode', 'city', 'state'], paranoid: false, transaction })
    : [];
  const byId = new Map(properties.map((p) => [p.id, p]));
  const tracking = await summarizeCartEvents(cartIds, transaction);

  return carts.map((cart) => {
    const link = links.find((l) => l.cartId === cart.id);
    return {
      id: cart.id,
      opportunityId: cart.opportunityId,
      status: effectiveStatus(cart),
      expiresAt: cart.expiresAt,
      currentVersion: cart.currentVersion,
      createdAt: cart.get('created_at') || cart.createdAt,
      shareLink: link ? { token: link.token, createdAt: link.get('created_at') || link.createdAt || null } : null,
      versions: versions
        .filter((v) => v.cartId === cart.id)
        .map((v) => ({
          versionNumber: v.versionNumber,
          createdAt: v.get('created_at') || v.createdAt || null,
          properties: (v.propertyIdsJson || []).map((id) => {
            const p = byId.get(id);
            return { id, title: p ? p.title : null, internalCode: p ? p.internalCode : null, city: p ? p.city : null, state: p ? p.state : null };
          }),
        })),
      tracking: tracking.get(cart.id),
    };
  });
}

module.exports = { listOpportunityCarts, effectiveStatus };
