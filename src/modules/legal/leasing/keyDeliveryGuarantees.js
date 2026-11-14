'use strict';

const { Guarantee, ContractRequirement } = require('../../../models');
const AppError = require('../../../utils/AppError');

/**
 * Livro §10 "Exigir documentos e garantias válidos". Válida = status ACTIVE e hoje dentro de [startsAt, endsAt] (A04: o job
 * de vencimento pode não ter rodado ainda; R3-3: vigência que só começa no futuro não vale).
 *  - Contrato cujo checklist exige garantia (exigência do tipo GUARANTEE — locação, pelo Motor de Regras REG-JUR-001) só
 *    entrega as chaves com uma garantia válida de verdade: um arquivo anexado à exigência não basta. Só a DISPENSA formal da
 *    exigência (WAIVED, com motivo, decisão humana registrada — JUR-003) libera a entrega sem garantia.
 *  - Contrato sem essa exigência (venda, por exemplo) não precisa de garantia; mas, se tiver garantia cadastrada, ao menos uma
 *    precisa estar válida (regra que já valia).
 */
function isValidGuarantee(g, now) {
  return g.status === 'ACTIVE' && (!g.startsAt || new Date(g.startsAt) <= now) && (!g.endsAt || new Date(g.endsAt) >= now);
}

async function assertDeliveryGuarantees(contract, transaction, now = new Date()) {
  const guarantees = await Guarantee.findAll({ where: { contractId: contract.id }, transaction });
  const valid = guarantees.find((g) => isValidGuarantee(g, now));
  if (valid) return valid;
  if (guarantees.length > 0) {
    throw AppError.conflict(
      'Não é possível liberar as chaves: existem garantias cadastradas para o contrato, mas nenhuma está ativa e dentro da vigência.',
      'LEGAL_KEY_DELIVERY_GUARANTEE_INVALID'
    );
  }
  const requirements = await ContractRequirement.findAll({ where: { contractId: contract.id, requirementType: 'GUARANTEE' }, transaction });
  if (requirements.some((r) => r.status !== 'WAIVED')) {
    throw AppError.conflict(
      'Não é possível liberar as chaves: o contrato exige garantia e nenhuma garantia foi cadastrada (anexar um arquivo à exigência não substitui a garantia).',
      'LEGAL_KEY_DELIVERY_GUARANTEE_REQUIRED'
    );
  }
  return null;
}

module.exports = { assertDeliveryGuarantees, isValidGuarantee };
