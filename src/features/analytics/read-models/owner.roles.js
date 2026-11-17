'use strict';

/**
 * DI-BI2-10 — papéis de owner (responsável pela reconciliação) dos indicadores do BI. Fonte única do texto padrão de `analytics.owner.<código>` ("Área (papel código)")
 * e dos papéis que a migration 20261116230000 e a concessão padrão (POST /governance/permissions/apply-default) criam em cada empresa. O aceite do owner
 * (metrics/acceptance.owner.js) procura o papel pelo nome entre parênteses, comparando o nome do papel sem diferenciar maiúsculas (mas não acentos): por isso os
 * códigos são sem acento, e cada área tem um só código (antes havia "jurídico-gestor" e "juridico-gestor", "tecnologia-gestor", "ia-gestor" e "ti-gestor").
 */
const OWNER_ROLES = Object.freeze({
  'financeiro-gestor': 'Diretoria Financeira',
  'comercial-gestor': 'Gerência Comercial',
  'locacao-gestor': 'Gerência de Locação',
  'obras-gestor': 'Diretoria de Obras',
  'estoque-gestor': 'Almoxarifado',
  'juridico-gestor': 'Jurídico',
  'correspondente-gestor': 'Correspondente Bancário',
  'marketing-gestor': 'Marketing',
  'atendimento-gestor': 'Atendimento',
  'ti-gestor': 'Tecnologia',
});

const OWNER_ROLE_CODES = Object.freeze(Object.keys(OWNER_ROLES));

/** Texto padrão do owner: "Diretoria Financeira (papel financeiro-gestor)". Código fora do catálogo é erro de programação. */
function ownerText(code) {
  if (!OWNER_ROLES[code]) throw new Error(`Papel de owner fora do catálogo: ${code}.`);
  return `${OWNER_ROLES[code]} (papel ${code})`;
}

/** Descrição do papel de owner criado pela migration e pela concessão padrão. */
const ownerRoleDescription = (code) => `Owner dos indicadores do BI da área ${OWNER_ROLES[code]}: reconcilia e dá o aceite (papel padrão do BI).`;

// Textos padrão antigos, divergentes do catálogo, e o texto que os substitui (a migration corrige o que ficou gravado com eles).
const LEGACY_OWNER_TEXTS = Object.freeze({
  'Jurídico (papel jurídico-gestor)': ownerText('juridico-gestor'),
  'Gerência de Locação (papel locação-gestor)': ownerText('locacao-gestor'),
  'Gestor de Estoque (papel estoque-gestor)': ownerText('estoque-gestor'),
  'Tecnologia (papel tecnologia-gestor)': ownerText('ti-gestor'),
  'Tecnologia/IA (papel ia-gestor)': ownerText('ti-gestor'),
});

// Permissões que o papel de owner recebe ao ser criado (DI-D708-1: o owner vê o indicador e dá o aceite). O resto é concedido pelo administrador.
const OWNER_ROLE_PERMISSIONS = Object.freeze(['analytics:read', 'analytics:accept']);

module.exports = { OWNER_ROLES, OWNER_ROLE_CODES, ownerText, ownerRoleDescription, LEGACY_OWNER_TEXTS, OWNER_ROLE_PERMISSIONS };
