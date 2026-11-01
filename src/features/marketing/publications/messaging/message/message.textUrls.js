'use strict';

const security = require('../../../security');

/**
 * M9-D414 (reabertura L-5) / M9-D433 — o que o destinatário lê passa pela regra de URL externa: o texto final (já com as variáveis do template), o assunto, o pré-cabeçalho e
 * cada variável de texto enviada ao canal. O envio roda por mensagem, então vale a regra estática (https, allowlist, encurtador, credencial, IP), sem DNS por mensagem
 * (DI-D433-3); a regra completa, com DNS e redirecionamento, vale quando alguém digita o texto (definição da automação e template). Reprovada = 422 MKT_URL_NOT_ALLOWED.
 */
async function assertMessageTexts(input, text, tenant, transaction) {
  const texts = [['text', text], ['subject', input.subject], ['preheader', input.preheader]];
  // Tetos de tamanho por variável, por campo e no total; array e objeto aninhados também são varridos (N-6); candidato ambíguo sem aprovador humano é recusado (rodada 4, M-2).
  await security.assertTextFieldsSafe(texts, input.variables, { tenant, transaction, origin: 'SYSTEM' });
}

module.exports = { assertMessageTexts };
