'use strict';

/**
 * Módulo jurídico (Guia do Marco 5, §2 src/modules/legal/). A ordem abaixo é a do Guia §1 (ordem
 * exata de implementação): modelos/cláusulas, contratos, requirements, assinatura, garantias,
 * vistorias, chaves, obrigações, aditivos/notificações, processos, prazos, dossiê, eventos e NAY.
 */
const ORDEM_DO_GUIA = [
  ['1. contract_templates + clause_library + versionamento', './contracts/application/template.service'],
  ['2. contracts + contract_parties + contract_versions', './contracts/application/contract.service'],
  ['3. contract_requirements e gate engine', './contracts/application/requirement.service'],
  ['4. signature adapter + webhook idempotente', './signatures/signature.service'],
  ['5. guarantees', './leasing/guarantee.service'],
  ['6. inspections + items + media + signature', './inspections/inspection.service'],
  ['7. key_deliveries', './leasing/key-delivery.service'],
  ['8. lease_obligations', './leasing/lease-obligation.service'],
  ['9. addenda + notices', './contracts/application/notices.service'],
  ['10. legal_cases + case_parties', './cases/legal-case.service'],
  ['11. legal_deadlines + escalonamento', './cases/deadline.service'],
  ['12. evidence_packages', './cases/evidence-package.service'],
  ['13. eventos', './shared/legalEvents.service'],
  ['14. NAY jurídica read/suggest', './cases/legalNay.service'],
];

/** Carrega os serviços na ordem do Guia e devolve { passo, servico }. As rotas ficam em shared/legal.routes.js. */
function registrar() {
  return ORDEM_DO_GUIA.map(([passo, caminho]) => ({ passo, caminho, servico: require(caminho) }));
}

module.exports = { ORDEM_DO_GUIA, registrar };
