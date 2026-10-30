'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { getSetting } = require('../../../settings/settings.service');
const { nameVariables, opportunityOwner } = require('./leadPorts');
const { LINK_BASE_KEY } = require('../reviews/review.settings');
const reviewPorts = require('../reviews/review.ports');

/**
 * M9-D421 — o que a automação do Radar registra no runner: o filtro do radar ativo, o corretor do radar, as variáveis do texto (só campos públicos do imóvel, via
 * marketing.v_public_property, já com a política de endereço aplicada) e o link rastreável (M9-D431) para a página pública do imóvel.
 */
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });
const RADAR_ACTIVE_FILTER = 'RADAR_ACTIVE';
const SITE_BASE_KEY = 'marketing.seo.url_base'; // base do site público (M9-D427); "nenhuma" = sem site
const SITE_NONE = 'nenhuma';
const PUBLIC_PROPERTY_ROOT = '/imoveis'; // a página do imóvel resolve pelo publicId no fim do caminho (M9-D427)
const TYPE_LABEL = Object.freeze({ RESIDENTIAL: 'Imóvel residencial', COMMERCIAL: 'Imóvel comercial', LAND: 'Terreno', RURAL: 'Imóvel rural' });
const money = (value) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);

const radarOf = async (event, tenant, transaction) => {
  const id = event && event.payload && event.payload.radarId;
  return id ? (await q('SELECT id, person_id, status, created_by FROM crm.property_radars WHERE id = :id AND company_id = :c AND deleted_at IS NULL', { id, c: tenant.companyId }, transaction))[0] || null : null;
};

/** Radar inativo (pausado, encerrado ou apagado) não gera nada: o match é de um perfil de busca que não vale mais. */
async function radarActiveFilter(cand, ctx) {
  const radar = await radarOf(ctx.event, ctx.tenant, ctx.transaction);
  return Boolean(radar) && radar.status === 'ACTIVE';
}

/** Corretor do radar (quem o criou); sem ele, o dono da carteira da pessoa; sem nenhum, null (a tarefa vai ao dono da automação). */
async function radarBroker(context) {
  const radar = await radarOf(context.event, context.tenant, context.transaction);
  return (radar && radar.created_by) || opportunityOwner(context);
}

async function publicProperty(propertyId, tenant, transaction) {
  if (!propertyId) return null;
  return (await q('SELECT public_id, tipo, finalidade, bairro, quartos, preco_venda, preco_locacao FROM marketing.v_public_property WHERE company_id = :c AND property_id = :p', { c: tenant.companyId, p: propertyId }, transaction))[0] || null;
}

/** "Imóvel residencial com 3 quartos no Jardim Europa, por R$ 500.000": só o que a visão pública traz; campo sem valor não entra na frase. */
function summaryOf(p) {
  const rent = String(p.finalidade).toUpperCase() === 'LOCACAO';
  const price = rent ? p.preco_locacao : p.preco_venda;
  const parts = [TYPE_LABEL[String(p.tipo).toUpperCase()] || 'Imóvel'];
  if (Number.isInteger(p.quartos) && p.quartos > 0) parts.push(`com ${p.quartos} ${p.quartos === 1 ? 'quarto' : 'quartos'}`);
  if (p.bairro) parts.push(`no ${p.bairro}`);
  const base = parts.join(' ');
  return price !== null && price !== undefined && Number(price) > 0 ? `${base}, por ${money(Number(price))}${rent ? ' ao mês' : ''}` : base;
}

/**
 * Variáveis do match: `nome` (nome completo, para o corretor), `primeiro_nome`, `codigo` (código interno, só para a tarefa e a notificação do corretor) e `resumo_imovel` (o texto
 * do cliente: só campos públicos). Sem imóvel público (despublicado), só os nomes: a mensagem não sai e o corretor ainda recebe a sugestão.
 */
async function matchVariables(context) {
  const { tenant, transaction, personId, event } = context;
  const names = await nameVariables(context);
  const [full] = personId ? await q(`SELECT btrim(COALESCE(NULLIF(btrim(preferred_name), ''), legal_name)) AS name FROM people.persons WHERE id = :p AND company_id = :c AND deleted_at IS NULL`, { p: personId, c: tenant.companyId }, transaction) : [];
  const propertyId = event && event.payload && event.payload.propertyId;
  const [internal] = propertyId ? await q('SELECT internal_code FROM real_estate.properties WHERE id = :p AND company_id = :c', { p: propertyId, c: tenant.companyId }, transaction) : [];
  const property = await publicProperty(propertyId, tenant, transaction);
  return { ...names, ...(full ? { nome: full.name } : {}), ...(internal ? { codigo: internal.internal_code } : {}), ...(property ? { resumo_imovel: summaryOf(property) } : {}) };
}

/**
 * Link rastreável da mensagem (M9-D431): o destino é a página pública do imóvel no site da empresa (`marketing.seo.url_base`) e o endereço que o cliente recebe é o do rastreio
 * (`marketing.review.url_base_rastreio`, onde o /t/ é atendido). Sem um dos dois endereços, sem imóvel público ou com destino recusado pela regra de URL, devolve null e a mensagem não sai.
 */
async function radarLink({ tenant, transaction, event, channel, actorUserId }) {
  const [site, tracking] = [String(await getSetting(SITE_BASE_KEY, tenant, transaction, SITE_NONE) || '').trim(), String(await getSetting(LINK_BASE_KEY, tenant, transaction, '') || '').trim()];
  const property = await publicProperty(event && event.payload && event.payload.propertyId, tenant, transaction);
  if (!site || site === SITE_NONE || !tracking || !property || !['WHATSAPP', 'EMAIL'].includes(channel)) return null;
  try {
    const link = await reviewPorts.createLink({ tenant, actor: actorUserId, input: { targetUrl: `${site.replace(/\/+$/, '')}${PUBLIC_PROPERTY_ROOT}/${property.public_id}`, channel, utmCampaign: 'radar' } }, transaction);
    return `${tracking.replace(/\/+$/, '')}${link.path}`;
  } catch (err) {
    if (err && err.code === 'MKT_URL_NOT_ALLOWED') return null;
    throw err;
  }
}

module.exports = { RADAR_ACTIVE_FILTER, radarActiveFilter, radarBroker, matchVariables, radarLink, summaryOf };
