'use strict';

const { typeLabel } = require('./seo.slug');

/**
 * M9-D427 regras 2 e 3 — metadata (title, description, Open Graph, robots) e JSON-LD `RealEstateListing`, construídos SÓ de campos do read model
 * público já sanitizado (M9-D403). Campo ausente é omitido: nada é inventado. A política de endereço já foi aplicada pelo read model; aqui o JSON-LD
 * ainda repete a regra: com SO_BAIRRO ou OCULTO não sai rua, número nem coordenada (o cadastro nem tem coordenada; o centro do bairro não é
 * publicado, DI-D427-2). Imagem do Open Graph: só foto autorizada (o read model só traz foto aprovada), pelo id da mídia.
 */
const money = (value) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
const present = (value) => value !== null && value !== undefined && value !== '';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function headline(p) {
  const tipo = typeLabel(p.tipo);
  const quartos = Number.isInteger(p.quartos) && p.quartos > 0 ? ` com ${plural(p.quartos, 'quarto', 'quartos')}` : '';
  const finalidade = { VENDA: ' à venda', LOCACAO: ' para alugar' }[p.finalidade] || '';
  const place = [p.bairro, p.cidade].filter(present).join(', ');
  return `${tipo || 'Imóvel'}${quartos}${finalidade}${place ? ` em ${place}` : ''}`;
}

function facts(p) {
  const list = [];
  if (present(p.areaUtilM2)) list.push(`${p.areaUtilM2} m² de área útil`);
  else if (present(p.areaTotalM2)) list.push(`${p.areaTotalM2} m² de área total`);
  if (Number.isInteger(p.suites) && p.suites > 0) list.push(plural(p.suites, 'suíte', 'suítes'));
  if (Number.isInteger(p.banheiros) && p.banheiros > 0) list.push(plural(p.banheiros, 'banheiro', 'banheiros'));
  if (Number.isInteger(p.vagas) && p.vagas > 0) list.push(plural(p.vagas, 'vaga', 'vagas'));
  if (Array.isArray(p.features) && p.features.length > 0) list.push(p.features.join(', '));
  return list;
}

function priceOf(p) {
  if (present(p.precoVenda)) return { value: p.precoVenda, label: `Venda: ${money(p.precoVenda)}` };
  if (present(p.precoLocacao)) return { value: p.precoLocacao, label: `Aluguel: ${money(p.precoLocacao)}` };
  return null;
}

/** Descrição montada só de campos presentes; `approvedText` (texto já aprovado pelo validador factual) tem prioridade quando existe. */
function describe(p, approvedText) {
  if (typeof approvedText === 'string' && approvedText.trim()) return approvedText.trim().replace(/\s+/g, ' ').slice(0, 300);
  const parts = [headline(p), ...facts(p)];
  const price = priceOf(p);
  if (price) parts.push(price.label);
  return `${parts.join('. ')}.`.slice(0, 300);
}

function jsonLd(p, { title, description, url, policy }) {
  const price = priceOf(p);
  const address = { '@type': 'PostalAddress', ...(present(p.cidade) ? { addressLocality: p.cidade } : {}), ...(present(p.uf) ? { addressRegion: p.uf } : {}), addressCountry: 'BR' };
  if (['COMPLETO', 'RUA_SEM_NUMERO'].includes(policy) && present(p.logradouro)) address.streetAddress = [p.logradouro, policy === 'COMPLETO' ? p.numeroEndereco : null].filter(present).join(', ');
  const about = {
    '@type': 'Accommodation',
    ...(Number.isInteger(p.quartos) ? { numberOfBedrooms: p.quartos } : {}),
    ...(Number.isInteger(p.banheiros) ? { numberOfBathroomsTotal: p.banheiros } : {}),
    ...(present(p.areaUtilM2) ? { floorSize: { '@type': 'QuantitativeValue', value: p.areaUtilM2, unitCode: 'MTK' } } : {}),
    address,
    ...(present(p.bairro) ? { containedInPlace: { '@type': 'Place', name: p.bairro } } : {}),
  };
  return {
    '@context': 'https://schema.org',
    '@type': 'RealEstateListing',
    name: title,
    description,
    ...(url ? { url } : {}),
    ...(present(p.publicadoEm) ? { datePosted: p.publicadoEm } : {}),
    ...(price ? { offers: { '@type': 'Offer', price: price.value, priceCurrency: 'BRL' } } : {}),
    about,
  };
}

/** { title, description, robots, canonical, openGraph, jsonLd } do read model sanitizado `model` ({ payload, policy }). */
function buildSeoMetadata(model, { canonicalUrl, indexable = true, approvedText = null } = {}) {
  const p = model.payload;
  const title = headline(p).slice(0, 70);
  const description = describe(p, approvedText);
  const og = { type: 'website', title, description, ...(canonicalUrl ? { url: canonicalUrl } : {}), ...(Array.isArray(p.fotosAutorizadas) && p.fotosAutorizadas[0] ? { imageMediaId: p.fotosAutorizadas[0] } : {}) };
  return {
    title,
    description,
    robots: indexable ? 'index,follow' : 'noindex,nofollow',
    canonical: canonicalUrl || null,
    openGraph: og,
    jsonLd: jsonLd(p, { title, description, url: canonicalUrl, policy: model.policy }),
  };
}

module.exports = { buildSeoMetadata, headline, describe };
