'use strict';

/**
 * M9-D693 — áreas do negócio como a diretoria as chama. Mesma convenção de rótulos do mapa domínio-permissão do BI (M9-D700): o
 * administrador escreve "Financeiro, Locação" nos parâmetros do briefing e o servidor resolve para o domínio de métrica.
 */
const AREA_BY_DOMAIN = Object.freeze({
  FINANCE: 'Financeiro', CRM: 'Comercial', PROPERTIES: 'Imóveis', MARKETING: 'Marketing', SUPPORT: 'Atendimento', RENTAL: 'Locação',
  LEGAL: 'Jurídico', CONSTRUCTION: 'Obras', INVENTORY: 'Estoque', CORRESPONDENT: 'Correspondente', TECH_AI: 'Tecnologia', GENERAL: 'Geral',
});

const norm = (text) => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

const DOMAIN_BY_LABEL = Object.freeze(Object.fromEntries(Object.entries(AREA_BY_DOMAIN).map(([domain, label]) => [norm(label), domain])));

const areaOf = (domain) => AREA_BY_DOMAIN[domain] || domain || 'Geral';
const domainOfLabel = (label) => DOMAIN_BY_LABEL[norm(label)] || null;

module.exports = { AREA_BY_DOMAIN, areaOf, domainOfLabel, norm };
