'use strict';

// Cenário da M9-D632 (exemplos do livro em escala): hoje é 28/10/2026 12:00 de São Paulo. Visitas (60 agendadas, 48 realizadas => 80,00%), propostas
// (12 enviadas: 4 aceitas, 3 recusadas, 5 em aberto => aceite 57,14%), imóveis (venda, locação, sem oferta), faixas de dias sem venda e mudanças de
// preço. Entram também os registros que NÃO devem contar (cancelada, de outro mês, excluída, às 23:30 e 00:30 de São Paulo na virada do dia).
const bi = require('./m9d632Env');

const { src } = bi;
const iso = (date, time = '15:00:00') => `${date}T${time}Z`;
const LONG_AGO = '2025-01-01T15:00:00Z';

const visit = (env, t, c) => src.insert(env, 'crm.visits', t, { property_id: c.property || src.uuid(), person_id: src.uuid(), scheduled_at: c.at, status: c.status || 'SCHEDULED', agent_user_id: c.agent === undefined ? null : c.agent });

async function seedVisits(env, t, broker) {
  const ids = [];
  for (let i = 0; i < 12; i += 1) ids.push(await visit(env, t, { at: iso('2026-10-10'), status: 'SCHEDULED', agent: broker }));
  for (let i = 0; i < 47; i += 1) ids.push(await visit(env, t, { at: iso('2026-10-12'), status: 'DONE', agent: broker }));
  ids.push(await visit(env, t, { at: '2026-10-29T02:30:00Z', status: 'DONE', agent: broker })); // 23:30 de 28/10 em São Paulo: cai no dia 28, dentro do período
  await visit(env, t, { at: '2026-10-29T03:30:00Z', status: 'SCHEDULED', agent: broker }); // 00:30 de 29/10 em São Paulo: depois da data-base, fora
  for (let i = 0; i < 3; i += 1) await visit(env, t, { at: iso('2026-10-11'), status: 'CANCELED', agent: broker });
  for (let i = 0; i < 2; i += 1) await visit(env, t, { at: iso('2026-09-20'), status: 'DONE', agent: broker });
  const deleted = await visit(env, t, { at: iso('2026-10-11'), status: 'DONE', agent: broker });
  await src.update(env, 'crm.visits', deleted, { deleted_at: iso('2026-10-12') });
  return ids;
}

async function seedProposals(env, t, broker) {
  const mk = async (status, value, extra = {}) => src.insert(env, 'crm.proposals', t, { opportunity_id: await src.opportunity(env, t, { owner: broker, created: iso('2026-10-01') }), value, status, sent_at: iso('2026-10-15'), decided_at: ['ACCEPTED', 'REJECTED'].includes(status) ? iso('2026-10-20') : null, ...extra });
  const ids = [];
  for (const [status, value] of [['ACCEPTED', '500000.00'], ['ACCEPTED', '350000.50'], ['ACCEPTED', '420000.00'], ['ACCEPTED', '180000.00'], ['REJECTED', '300000.00'], ['REJECTED', '250000.00'], ['REJECTED', '90000.25'],
    ['SENT', '210000.00'], ['SENT', '130000.00'], ['SENT', '99999.99'], ['UNDER_NEGOTIATION', '620000.00'], ['SENT', '75000.00']]) ids.push(await mk(status, value));
  await mk('SENT', '111.11', { sent_at: '2026-10-01T02:30:00Z' }); // 23:30 de 30/09 em São Paulo: setembro, fora
  await mk('DRAFT', '222.22', { sent_at: null });
  const gone = await mk('SENT', '333.33');
  await src.update(env, 'crm.proposals', gone, { deleted_at: iso('2026-10-16') });
  return ids;
}

/** Imóvel + ofertas ativas (`offers`: ['SALE'], ['RENT'] ou []). */
async function propertyOf(env, t, c) {
  const id = await src.property(env, t, { status: c.status || 'AVAILABLE', publication: c.publication || 'PUBLISHED', publishedAt: c.publishedAt || null, created: c.created || LONG_AGO, createdBy: c.createdBy || null });
  if (c.type) await src.update(env, 'real_estate.properties', id, { property_type: c.type });
  for (const type of c.offers || []) await src.offer(env, t, { property: id, type, price: c.price || '500000.00' });
  return id;
}

/** Carteira: 9 disponíveis (venda 5, locação 3, sem oferta 1), mais vendido, inativo e excluído (fora). Cinco à venda publicados em faixas diferentes. */
async function seedProperties(env, t, broker) {
  const ids = {};
  const property = (e, tt, c) => propertyOf(e, tt, { createdBy: broker, ...c });
  ids.s10 = await property(env, t, { publishedAt: iso('2026-10-18'), offers: ['SALE'], type: 'APARTMENT' }); // 10 dias
  ids.s30 = await property(env, t, { publishedAt: iso('2026-09-28'), offers: ['SALE'], type: 'APARTMENT' }); // 30 dias (limite da 1ª faixa)
  ids.s31 = await property(env, t, { publishedAt: iso('2026-09-27'), offers: ['SALE'], type: 'HOUSE' }); // 31 dias
  ids.s120 = await property(env, t, { publishedAt: iso('2026-06-30'), offers: ['SALE'], type: 'HOUSE' }); // 120 dias
  ids.s200 = await property(env, t, { publishedAt: iso('2026-04-11'), offers: ['SALE'], type: 'LAND' }); // 200 dias
  ids.r1 = await property(env, t, { publishedAt: iso('2026-10-01'), offers: ['RENT'], type: 'APARTMENT' });
  ids.r2 = await property(env, t, { publishedAt: iso('2026-09-01'), offers: ['RENT'], type: 'APARTMENT' });
  ids.r3 = await property(env, t, { publication: 'DRAFT', offers: ['RENT'], type: 'HOUSE' });
  ids.none = await property(env, t, { publication: 'DRAFT', type: 'HOUSE' });
  ids.sold = await property(env, t, { status: 'SOLD', publishedAt: iso('2026-01-01'), offers: ['SALE'], type: 'HOUSE' });
  ids.inactive = await property(env, t, { publication: 'INACTIVE', publishedAt: iso('2026-01-01'), offers: ['SALE'] });
  ids.gone = await property(env, t, { publishedAt: iso('2026-01-01'), offers: ['SALE'] });
  await src.update(env, 'real_estate.properties', ids.gone, { deleted_at: iso('2026-10-02') });
  ids.draftSale = await property(env, t, { publication: 'DRAFT', offers: ['SALE'], type: 'HOUSE' }); // à venda, mas ainda não publicado: fora do "sem venda"
  return ids;
}

/** Oito mudanças de preço no mês (7 com preço anterior, 1 primeira entrada) e duas na virada do dia (23:30 conta, 00:30 não). */
async function seedPrices(env, t) {
  const offer = src.uuid();
  const h = (oldPrice, newPrice, at) => src.priceHistory(env, t, { offer, oldPrice, newPrice, at });
  await h('100000.00', '90000.00', iso('2026-10-05')); // -10%
  await h('200000.00', '190000.00', iso('2026-10-06')); // -5%
  await h('300000.00', '291000.00', iso('2026-10-07')); // -3%
  await h('400000.00', '404000.00', iso('2026-10-08')); // +1%
  await h('500000.00', '490000.00', iso('2026-10-09')); // -2%
  await h('250000.00', '247500.00', iso('2026-10-10')); // -1%
  await h('80000.00', '79200.00', iso('2026-10-11')); // -1%
  await h('0.00', '150000.00', iso('2026-10-12')); // primeira entrada: conta como mudança, fora da variação
  await h('100000.00', '110000.00', '2026-10-29T02:30:00Z'); // 23:30 de 28/10 em São Paulo: dentro (+10%)
  await h('100000.00', '120000.00', '2026-10-29T03:30:00Z'); // 00:30 de 29/10: fora
  await h('100000.00', '50000.00', iso('2026-09-15')); // setembro: fora
}

module.exports = { ...bi, iso, visit, property: propertyOf, seedVisits, seedProposals, seedProperties, seedPrices, LONG_AGO };
