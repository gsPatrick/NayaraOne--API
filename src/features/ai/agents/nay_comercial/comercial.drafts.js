'use strict';

// M9-D034 — "descrições" e "recuperação" do livro: só RASCUNHO de texto, feito com fatos do cadastro (nada inventado), com fonte, sem
// publicar nem enviar. O texto sai de modelo fixo sobre os campos preenchidos; campo vazio simplesmente não aparece.
const { Property, PropertyOffer } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { dateBR, brl, plural } = require('./comercial.format');

const TYPE = Object.freeze({ APARTMENT: 'apartamento', HOUSE: 'casa', LAND: 'terreno', COMMERCIAL: 'imóvel comercial', FARM: 'chácara', ROOM: 'sala' });
const BANNER = 'RASCUNHO — não foi publicado nem enviado; revise antes de usar.';

const notFound = () => new AppError('Dado não encontrado.', 404, 'AI_CROSS_COMPANY_BLOCKED');

/** Atributos do cadastro que existem (valor preenchido), com o rótulo que vai ao texto. Nada além disso entra na descrição. */
function propertyFacts(p, offer) {
  const facts = [];
  const add = (label, value) => { if (value !== null && value !== undefined && value !== '') facts.push({ label, value: String(value) }); };
  add('tipo', TYPE[String(p.propertyType || '').toUpperCase()] || (p.propertyType ? String(p.propertyType).toLowerCase() : null));
  add('cidade', p.city);
  add('estado', p.state);
  add('área total', p.areaTotalM2 === null || p.areaTotalM2 === undefined ? null : `${Number(p.areaTotalM2).toLocaleString('pt-BR')} m²`);
  add('quartos', p.bedrooms);
  add('vagas', p.parkingSpots);
  if (offer) add(offer.offerType === 'RENT' ? 'aluguel' : 'preço', brl(offer.askingPrice));
  return facts;
}

async function propertyDraft(propertyId, now, transaction) {
  const property = await Property.findByPk(propertyId, { include: [{ model: PropertyOffer, as: 'offers', required: false }], transaction });
  if (!property) throw notFound();
  const offer = (property.offers || []).find((o) => o.status === 'ACTIVE') || null;
  const facts = propertyFacts(property, offer);
  const asOf = now.toISOString();
  const lista = facts.map((f) => `${f.label}: ${f.value}`);
  const titulo = property.title ? ` "${property.title}"` : '';
  return {
    answer: [BANNER, `Descrição do imóvel${titulo} [1]: ${lista.length ? lista.join('; ') : 'o cadastro ainda não tem atributos preenchidos'}.`, 'Só constam atributos do cadastro; o que não está preenchido não foi incluído.'].join('\n'),
    snapshotAt: asOf,
    structured: { rascunho: true, tipo: 'DESCRICAO_IMOVEL', imovel: property.id, atributos: facts.map((f) => f.label) },
    sources: [{ sourceType: 'READ_MODEL', sourceRef: `properties:${property.id}`, title: 'properties', retrievedAt: asOf, text: `Imóvel${titulo}. ${lista.join('. ')}.` }],
  };
}

function recoveryDraft(facts) {
  const nome = facts.customerName || 'tudo bem';
  const ultima = facts.lastInteractionAt ? `nossa última conversa foi em ${dateBR(facts.lastInteractionAt)}` : 'ainda não conversamos sobre o seu interesse';
  const dias = facts.daysWithoutContact;
  const corpo = `Olá, ${nome}! Passando para saber se ainda posso ajudar com a sua busca${dias ? ` (${ultima}, há ${dias} ${plural(dias, 'dia', 'dias')})` : ` (${ultima})`}. Se quiser, envio novas opções.`;
  return {
    answer: [BANNER, `Mensagem de recuperação para ${facts.customerName || 'o cliente'} [1]:`, corpo].join('\n'),
    snapshotAt: facts.asOf,
    structured: { rascunho: true, tipo: 'RECUPERACAO_CLIENTE', oportunidade: facts.opportunityId, enviada: false },
    sources: [{
      sourceType: 'READ_MODEL', sourceRef: `crm.opportunities:${facts.opportunityId}`, title: 'crm.opportunities', retrievedAt: facts.asOf,
      text: `Oportunidade ${facts.opportunityId}. Cliente ${facts.customerName || '—'}. Etapa ${facts.stage}. Última interação: ${facts.lastInteractionAt ? dateBR(facts.lastInteractionAt) : 'nenhuma'}. Dias sem contato: ${dias}.`,
    }],
  };
}

module.exports = { propertyDraft, recoveryDraft, propertyFacts, BANNER };
