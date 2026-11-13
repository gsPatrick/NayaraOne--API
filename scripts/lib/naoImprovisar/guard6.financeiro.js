'use strict';

const { API_ROOT, violation, listJs, codeLines } = require('./common');

// Pagamento ou intenção de pagamento marcado como pago/executado.
const MARCA_PAGO = /\bintent\.status\s*=\s*['"](?:CONFIRMED|EXECUTED|PAID|SETTLED)['"]|\bintent\.update\s*\(\s*\{[^}]*status\s*:\s*['"](?:CONFIRMED|EXECUTED|PAID|SETTLED)['"]/;
// O caminho de evidência: o status final do banco passa pelo envio (webhook assinado ou consulta de status) e gera `integration.dispatch.confirmed`.
// Só os arquivos que falam com o banco pelo hub (`application/services/bank-hub.js`) estão em jogo; a baixa manual com comprovante (payment.service#executePaymentIntent) não usa HTTP do banco.
const USA_BANCO = /require\(\s*['"]\.\/bank-hub['"]\s*\)|callBankSubmit|BankAdapter/; // M4-D140: o hub do banco é application/services/bank-hub.js
const EVIDENCIA = /applyStatusToDispatch|resolveDispatchByEvent|integration\.dispatch\.confirmed/;

function politicaPadrao() {
  return require('../../../src/features/integrations/providers/ports/operationPolicy').OPERATION_POLICY;
}

/**
 * Regra 6: "Não considerar HTTP success como fato financeiro". (a) toda operação perigosa do domínio BANK é confirmada só por status (`ON_STATUS`); (b) arquivo do Financeiro que fala com o banco e marca o pagamento
 * como pago precisa passar pelo caminho de evidência (status final por webhook assinado ou consulta, que confirma o envio e publica `integration.dispatch.confirmed`).
 */
function scan({ root = API_ROOT, policy = politicaPadrao() } = {}) {
  const achados = [];
  Object.entries(policy.BANK || {}).forEach(([operacao, p]) => {
    if (p.opClass === 'DANGEROUS' && p.confirmation !== 'ON_STATUS') {
      achados.push(violation(6, 'src/features/integrations/providers/ports/operationPolicy.js', 1, `A operação BANK ${operacao} é ${p.confirmation}: pagamento só se confirma por status final (ON_STATUS), nunca pelo HTTP 200.`));
    }
  });
  for (const rel of listJs(root, 'src/modules/finance')) {
    const linhas = codeLines(root, rel);
    if (!linhas.some((l) => USA_BANCO.test(l)) || linhas.some((l) => EVIDENCIA.test(l))) continue;
    linhas.forEach((linha, i) => {
      if (MARCA_PAGO.test(linha)) achados.push(violation(6, rel, i + 1, 'Pagamento marcado como pago sem passar pelo caminho de evidência (status final do banco e evento integration.dispatch.confirmed).', linha));
    });
  }
  return achados;
}

module.exports = { rule: 6, name: 'http_sucesso_nao_e_fato_financeiro', scan };
