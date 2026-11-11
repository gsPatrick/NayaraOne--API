'use strict';

const { sequelize } = require('../../models');

/**
 * Rastreio do carrinho de imóveis (livro do Marco 3 §14: link "com expiração e tracking"; "Visualização/clique podem gerar
 * eventos para CRM"). Cada visualização do link público e cada clique num imóvel vira uma linha append-only em crm.cart_events
 * (migration 20260101010313), com a versão vista — o carrinho é versionado "para saber o que foi enviado". O evento de domínio
 * (crm.cart.viewed / crm.cart.property_clicked) continua indo ao outbox na mesma transação (carts.service.js).
 */
async function recordCartEvent(cart, eventType, propertyId, transaction) {
  await sequelize.query(
    `INSERT INTO crm.cart_events (group_id, company_id, cart_id, version_number, event_type, property_id)
     VALUES (:g, :c, :cart, :v, :type, :property)`,
    { replacements: { g: cart.groupId, c: cart.companyId, cart: cart.id, v: cart.currentVersion, type: eventType, property: propertyId || null }, transaction }
  );
}

/** Resumo por carrinho: visualizações, cliques, último acesso e cliques por imóvel (para a tela do carrinho). */
async function summarizeCartEvents(cartIds, transaction) {
  const out = new Map(cartIds.map((id) => [id, { views: 0, clicks: 0, lastViewedAt: null, lastClickedAt: null, clicksByProperty: {}, viewsByVersion: {} }]));
  if (cartIds.length === 0) return out;
  const [rows] = await sequelize.query(
    `SELECT cart_id, event_type, property_id, version_number, count(*)::int AS n, max(occurred_at) AS last_at
       FROM crm.cart_events WHERE cart_id IN (:ids)
      GROUP BY cart_id, event_type, property_id, version_number`,
    { replacements: { ids: cartIds }, transaction }
  );
  for (const r of rows) {
    const s = out.get(r.cart_id);
    const last = r.last_at ? new Date(r.last_at).toISOString() : null;
    if (r.event_type === 'VIEWED') {
      s.views += r.n;
      s.viewsByVersion[r.version_number] = (s.viewsByVersion[r.version_number] || 0) + r.n;
      if (!s.lastViewedAt || last > s.lastViewedAt) s.lastViewedAt = last;
    } else {
      s.clicks += r.n;
      s.clicksByProperty[r.property_id] = (s.clicksByProperty[r.property_id] || 0) + r.n;
      if (!s.lastClickedAt || last > s.lastClickedAt) s.lastClickedAt = last;
    }
  }
  return out;
}

module.exports = { recordCartEvent, summarizeCartEvents };
