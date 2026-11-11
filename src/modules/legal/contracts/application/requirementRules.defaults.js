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
  NEW_PROPERTY_DELIVERY: [
    { requirementCode: 'NEW_DELIVERY_TERM', requirementType: 'DELIVERY_TERM', description: 'Termo de entrega.' },
    { requirementCode: 'NEW_FINAL_INSPECTION', requirementType: 'FINAL_INSPECTION', description: 'Vistoria final.' },
    { requirementCode: 'NEW_OWNER_MANUAL', requirementType: 'OWNER_MANUAL', description: 'Manual do proprietário.' },
    { requirementCode: 'NEW_PHOTOS', requirementType: 'PHOTOS', description: 'Fotos.' },
    { requirementCode: 'NEW_KEYS', requirementType: 'KEYS', description: 'Chaves.' },
  ],
  USED_PROPERTY_DELIVERY: [
    { requirementCode: 'USED_PROPERTY_TERM', requirementType: 'USED_PROPERTY_TERM', description: 'Termo específico deixando clara a natureza/estado do imóvel usado, conforme modelo jurídico aprovado.' },
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
  ADDENDUM: 'ADDENDUM', KEY_DELIVERY: 'NEW_PROPERTY_DELIVERY', USED_PROPERTY_DELIVERY: 'USED_PROPERTY_DELIVERY',
};

const DEFAULT_ACTION = Object.freeze({ templates: TEMPLATES, typeToTemplate: TYPE_TO_TEMPLATE });

// Hash (sha256 do JSON da ação) das políticas PADRÃO anteriores. Empresa cuja versão vigente ainda é exatamente um padrão
// antigo (nunca personalizou) recebe o padrão atual numa versão nova (requirementRules.service#resolveRequirementPolicy);
// política personalizada nunca é trocada.
const PREVIOUS_DEFAULT_HASHES = Object.freeze([
  'a222325e003107eeaa8a5e1f04a6319fbdcdcad34614e71645daa5f7ab90e683', // até o fechamento M5 vistorias/prazos (sem item da etapa KEY_DELIVERY)
]);

module.exports = { DEFAULT_ACTION, TEMPLATES, TYPE_TO_TEMPLATE, PREVIOUS_DEFAULT_HASHES };
