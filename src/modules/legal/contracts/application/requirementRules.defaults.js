'use strict';

/**
 * Padrão da regra REG-JUR-001 do Motor de Regras (checklist documental, Caderno M5 §7). É a política que a
 * empresa recebe na primeira geração de checklist (semente, versão 1 PUBLISHED) e que se troca publicando
 * nova versão da regra (requirementRules.service.js#publishRequirementRules) — nunca editando a vigente.
 *
 * Cada item pode ter `when` (condição na DSL declarativa do Motor de Regras, ruleEvaluator.js) sobre as
 * características do contrato, das partes e do imóvel (ver requirementRules.service.js#buildFacts), e `stage`
 * (etapa a partir da qual a pendência bloqueia — Guia §5 assertRequirementsSatisfied(contractId, targetStage);
 * padrão LEGAL_REVIEW, o comportamento anterior). Conteúdo dos fluxos = exemplos literais do Caderno §7.
 */
const sale = (prefix) => [
  { requirementCode: `${prefix}_BUYER_DOCS`, requirementType: 'BUYER_DOCUMENT', description: 'Documentos do comprador.' },
  { requirementCode: `${prefix}_SELLER_DOCS`, requirementType: 'SELLER_DOCUMENT', description: 'Documentos do vendedor.' },
  { requirementCode: `${prefix}_REGISTRATION`, requirementType: 'PROPERTY_REGISTRATION', description: 'Matrícula do imóvel.' },
  { requirementCode: `${prefix}_CERTIFICATES`, requirementType: 'CERTIFICATES', description: 'Certidões (negativas, ônus etc.).' },
  { requirementCode: `${prefix}_PAYMENT_DATA`, requirementType: 'PAYMENT_DATA', description: 'Dados de pagamento (à vista, parcelas ou torna).' },
];
const pjDocs = (prefix) => ({ requirementCode: `${prefix}_PJ_DOCS`, requirementType: 'PJ_DOCUMENT', description: 'Documentos da pessoa jurídica (contrato social e poderes de quem assina).', when: { fact: 'parties.anyPJ', op: '==', value: true } });
const procuracao = (prefix) => ({ requirementCode: `${prefix}_POWER_OF_ATTORNEY`, requirementType: 'POWER_OF_ATTORNEY', description: 'Procuração, quando alguma parte for representada por terceiro.', when: { fact: 'parties.anyRepresented', op: '==', value: true } });

// Fluxo "Entrega de casa nova" (§7) e a característica do imóvel que o seleciona (requirementRules.facts.js).
const NEW_ITEMS = {
  NEW_DELIVERY_TERM: { requirementCode: 'NEW_DELIVERY_TERM', requirementType: 'DELIVERY_TERM', description: 'Termo de entrega.' },
  NEW_FINAL_INSPECTION: { requirementCode: 'NEW_FINAL_INSPECTION', requirementType: 'FINAL_INSPECTION', description: 'Vistoria final.' },
  NEW_OWNER_MANUAL: { requirementCode: 'NEW_OWNER_MANUAL', requirementType: 'OWNER_MANUAL', description: 'Manual do proprietário.' },
  NEW_PHOTOS: { requirementCode: 'NEW_PHOTOS', requirementType: 'PHOTOS', description: 'Fotos.' },
  NEW_KEYS: { requirementCode: 'NEW_KEYS', requirementType: 'KEYS', description: 'Chaves.' },
};
const IS_NEW = { fact: 'property.isNew', op: '==', value: true };
const IS_USED = { fact: 'property.isNew', op: '==', value: false };

const TEMPLATES = {
  LEASE: [
    { requirementCode: 'LEASE_PF_PJ_DOCS', requirementType: 'PF_DOCUMENT', description: 'Documentos PF/PJ das partes (locador/locatário).' },
    pjDocs('LEASE'),
    { requirementCode: 'LEASE_GUARANTEE', requirementType: 'GUARANTEE', description: 'Garantia locatícia (fiador, seguro-fiança, caução ou título de capitalização).' },
    procuracao('LEASE'),
    { requirementCode: 'LEASE_INSPECTION', requirementType: 'INSPECTION', description: 'Vistoria de entrada do imóvel.' },
    { requirementCode: 'LEASE_OWNERSHIP', requirementType: 'OWNERSHIP_PROOF', description: 'Comprovação de titularidade do imóvel.' },
    { requirementCode: 'LEASE_OBLIGATIONS', requirementType: 'OBLIGATIONS', description: 'Definição de responsáveis pelas obrigações locatícias (IPTU/condomínio/água/luz/gás).' },
    // Fechamento M5 (livro §10 "Checklist calculado por Motor de Regras" + "Registrar quantidade/identificação de
    // chaves/controles"): exigência da etapa KEY_DELIVERY — só bloqueia a entrega das chaves, não as etapas anteriores.
    { requirementCode: 'LEASE_KEYS_LIST', requirementType: 'KEYS', stage: 'KEY_DELIVERY', description: 'Relação das chaves e controles a entregar, conferida com o locador.' },
  ],
  SALE_FINANCED: [
    { requirementCode: 'SALE_FIN_BUYER_DOCS', requirementType: 'BUYER_DOCUMENT', description: 'Documentos do comprador.' },
    { requirementCode: 'SALE_FIN_SELLER_DOCS', requirementType: 'SELLER_DOCUMENT', description: 'Documentos do vendedor.' },
    { requirementCode: 'SALE_FIN_REGISTRATION', requirementType: 'PROPERTY_REGISTRATION', description: 'Matrícula do imóvel.' },
    { requirementCode: 'SALE_FIN_CERTIFICATES', requirementType: 'CERTIFICATES', description: 'Certidões (negativas, ônus etc.).' },
    { requirementCode: 'SALE_FIN_FINANCING', requirementType: 'FINANCING', description: 'Documentação de financiamento.' },
    { requirementCode: 'SALE_FIN_PAYMENT_DATA', requirementType: 'PAYMENT_DATA', description: 'Dados de pagamento.' },
    pjDocs('SALE_FIN'),
    procuracao('SALE_FIN'),
  ],
  SALE: [...sale('SALE'), pjDocs('SALE'), procuracao('SALE')],
  SALE_CASH: [...sale('SALE_CASH'), pjDocs('SALE_CASH'), procuracao('SALE_CASH')],
  SALE_INSTALLMENTS: [...sale('SALE_INST'), pjDocs('SALE_INST'), procuracao('SALE_INST')],
  SALE_TRADE: [
    ...sale('SALE_TRADE'),
    { requirementCode: 'SALE_TRADE_ASSET', requirementType: 'TRADE_ASSET', description: 'Documentação do bem dado em permuta (matrícula/registro e avaliação).' },
    pjDocs('SALE_TRADE'),
    procuracao('SALE_TRADE'),
  ],
  SERVICE: [
    { requirementCode: 'SERVICE_PARTIES_DOCS', requirementType: 'PF_DOCUMENT', description: 'Documentos PF/PJ do contratante e do prestador.' },
    { requirementCode: 'SERVICE_SCOPE', requirementType: 'SERVICE_SCOPE', description: 'Escopo/proposta do serviço com preço e prazo.' },
  ],
  CONSTRUCTION: [
    { requirementCode: 'CONSTR_PARTIES_DOCS', requirementType: 'PJ_DOCUMENT', description: 'Documentos do contratante e da construtora/empreiteira.' },
    { requirementCode: 'CONSTR_PERMIT', requirementType: 'CONSTRUCTION_PERMIT', description: 'Projeto aprovado / alvará de construção.' },
    { requirementCode: 'CONSTR_ART_RRT', requirementType: 'TECHNICAL_RESPONSIBILITY', description: 'ART/RRT do responsável técnico.' },
    { requirementCode: 'CONSTR_BUDGET_SCHEDULE', requirementType: 'BUDGET_SCHEDULE', description: 'Orçamento e cronograma físico-financeiro.' },
    procuracao('CONSTR'),
  ],
  NEW_PROPERTY_DELIVERY: Object.values(NEW_ITEMS),
  USED_PROPERTY_DELIVERY: [
    { requirementCode: 'USED_PROPERTY_TERM', requirementType: 'USED_PROPERTY_TERM', description: 'Termo específico deixando clara a natureza/estado do imóvel usado, conforme modelo jurídico aprovado.' },
  ],
  // Termo de entrega de chaves (Caderno §3 KEY_DELIVERY): o checklist depende da característica do IMÓVEL (§7) — casa nova
  // (imóvel que nasceu de obra da empresa) segue o fluxo "Entrega de casa nova"; imóvel usado exige o termo específico.
  KEY_DELIVERY: [
    ...['NEW_DELIVERY_TERM', 'NEW_FINAL_INSPECTION', 'NEW_OWNER_MANUAL', 'NEW_PHOTOS', 'NEW_KEYS'].map((code) => ({ ...NEW_ITEMS[code], when: IS_NEW })),
    { requirementCode: 'USED_PROPERTY_TERM', requirementType: 'USED_PROPERTY_TERM', description: 'Termo específico deixando clara a natureza/estado do imóvel usado, conforme modelo jurídico aprovado.', when: IS_USED },
  ],
  ADDENDUM: [
    { requirementCode: 'ADDENDUM_PARTIES_DOCS', requirementType: 'PF_DOCUMENT', description: 'Documentos das partes que assinam o aditivo.' },
    procuracao('ADDENDUM'),
  ],
};

// Tipo do contrato -> modelo de checklist. Tipos de locação usam o checklist de locação; termos de entrega usam
// o fluxo de entrega do Caderno §7 (KEY_DELIVERY = entrega de casa nova; USED_PROPERTY_DELIVERY = imóvel usado).
const TYPE_TO_TEMPLATE = {
  LEASE: 'LEASE', LEASE_RESIDENTIAL: 'LEASE', LEASE_COMMERCIAL: 'LEASE', LEASE_SEASONAL: 'LEASE', PROPERTY_ADMIN: 'LEASE',
  SALE: 'SALE', SALE_CASH: 'SALE_CASH', SALE_FINANCED: 'SALE_FINANCED', SALE_TRADE: 'SALE_TRADE', SALE_INSTALLMENTS: 'SALE_INSTALLMENTS',
  SERVICE: 'SERVICE', CONSTRUCTION: 'CONSTRUCTION',
  ADDENDUM: 'ADDENDUM', KEY_DELIVERY: 'KEY_DELIVERY', USED_PROPERTY_DELIVERY: 'USED_PROPERTY_DELIVERY',
};

const DEFAULT_ACTION = Object.freeze({ templates: TEMPLATES, typeToTemplate: TYPE_TO_TEMPLATE });

// Hash (sha256 do JSON da ação) das políticas PADRÃO anteriores. Empresa cuja versão vigente ainda é exatamente um padrão antigo (nunca
// personalizou) recebe o padrão atual numa versão nova, auditada (requirementRules.service#resolveRequirementPolicy); política personalizada
// nunca é trocada. Integração dos Marcos 3 a 6 (13/11/2026): os padrões intermediários das duas correções do Marco 5 também contam como antigos.
const PREVIOUS_DEFAULT_HASHES = Object.freeze([
  'a222325e003107eeaa8a5e1f04a6319fbdcdcad34614e71645daa5f7ab90e683', // commits 52740c89 a 41addaa2 (sem as características do imóvel e sem o item da etapa KEY_DELIVERY)
  '54369817342bf5dbc8da7cd497465284752345eb0d09714a982a1cd4ce8bc0a0', // m5fix/contratos-verificacao (com as características do imóvel, sem o item da etapa KEY_DELIVERY)
  '5fd611496c45a6dd3ce63e3ef9d4da63fe3386c01363a5f2253fa60158942cb5', // m5fix/vistorias-prazos (com o item da etapa KEY_DELIVERY, sem as características do imóvel)
]);
// Mesmo conjunto com o nome da DI-M5CT-3 (semente anterior sem alteração da empresa).
const PREVIOUS_SEED_HASHES = PREVIOUS_DEFAULT_HASHES;

module.exports = { DEFAULT_ACTION, TEMPLATES, TYPE_TO_TEMPLATE, PREVIOUS_SEED_HASHES, PREVIOUS_DEFAULT_HASHES };
