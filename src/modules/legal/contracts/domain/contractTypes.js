'use strict';

const AppError = require('../../../../utils/AppError');

/**
 * Tipos de contrato do livro (Caderno M5 §3, 12 códigos). Contrato NOVO só nasce com um destes códigos (DI-M5CT-2).
 *
 * Códigos legados (anteriores ao §3): SALE e LEASE eram os genéricos de venda e locação; SERVICE ("prestação de serviço")
 * não existe no livro. Mesmo padrão do funil do Marco 3 (opportunityStages.js, DI-M3-FUNIL-1):
 *  - SALE e LEASE continuam aceitos NA ENTRADA só pela conversão explícita abaixo e são sempre GRAVADOS no código do livro;
 *    a conversão vai para a auditoria da criação (`contractTypeInformado` -> `contractTypeGravado`);
 *  - SERVICE não tem código equivalente no livro: contrato novo SERVICE é recusado (400 LEGAL_CONTRACT_TYPE_NOT_IN_BOOK);
 *  - linhas antigas gravadas com SALE/LEASE/SERVICE não são reescritas: continuam legíveis e com as regras de antes.
 */
const BOOK_CONTRACT_TYPES = Object.freeze([
  'SALE_CASH', 'SALE_FINANCED', 'SALE_TRADE', 'SALE_INSTALLMENTS',
  'LEASE_RESIDENTIAL', 'LEASE_COMMERCIAL', 'LEASE_SEASONAL', 'PROPERTY_ADMIN',
  'CONSTRUCTION', 'ADDENDUM', 'KEY_DELIVERY', 'USED_PROPERTY_DELIVERY',
]);
// Conversão explícita do código legado para o do livro: o genérico de venda vira "venda à vista" e o de locação,
// "locação residencial" (os usos que o genérico cobria na tela anterior ao §3).
const LEGACY_CONVERSION = Object.freeze({ SALE: 'SALE_CASH', LEASE: 'LEASE_RESIDENTIAL' });
const LEGACY_WITHOUT_BOOK_CODE = Object.freeze(['SERVICE']);
// Códigos que ainda podem existir gravados (leitura, filtros, regras de negócio de linhas antigas).
const STORED_CONTRACT_TYPES = Object.freeze([...BOOK_CONTRACT_TYPES, ...Object.keys(LEGACY_CONVERSION), ...LEGACY_WITHOUT_BOOK_CODE]);

/** Tipo de um contrato NOVO: { contractType (do livro), convertedFrom (código legado informado, ou null) }. */
function resolveNewContractType(informado) {
  const code = typeof informado === 'string' ? informado.trim().toUpperCase() : informado;
  if (BOOK_CONTRACT_TYPES.includes(code)) return { contractType: code, convertedFrom: null };
  if (LEGACY_CONVERSION[code]) return { contractType: LEGACY_CONVERSION[code], convertedFrom: code };
  if (LEGACY_WITHOUT_BOOK_CODE.includes(code)) {
    throw AppError.badRequest(
      `"${code}" não é tipo de contrato do Caderno (§3) e não tem código equivalente: use um destes: ${BOOK_CONTRACT_TYPES.join(', ')}.`,
      'LEGAL_CONTRACT_TYPE_NOT_IN_BOOK',
      { allowed: BOOK_CONTRACT_TYPES }
    );
  }
  throw AppError.badRequest(`"contractType" deve ser um de: ${BOOK_CONTRACT_TYPES.join(', ')}.`, 'LEGAL_CONTRACT_VALIDATION', { allowed: BOOK_CONTRACT_TYPES });
}

module.exports = { BOOK_CONTRACT_TYPES, LEGACY_CONVERSION, LEGACY_WITHOUT_BOOK_CODE, STORED_CONTRACT_TYPES, resolveNewContractType };
