'use strict';

const { API_ROOT, violation, listJs, codeLines } = require('./common');

// O objeto do banco inteiro virando carga de integração: serialização do modelo, valores crus, ou espalhar a entidade no payload.
const SERIALIZA = /\.toJSON\s*\(\s*\)|\.dataValues\b|\.get\s*\(\s*\{\s*plain\s*:\s*true/;
const STRINGIFY_ENTIDADE = /JSON\.stringify\s*\(\s*(?:row|entity|entidade|record|registro|model|instance|person|pessoa|message|mensagem|listing|anuncio|envelope|invoice|payment|pagamento|property|imovel|contract|contrato|proposal|proposta|case|caso|user|usuario)\s*[,)]/i;
const PAYLOAD_ESPALHADO = /\b(?:payload|snapshot|request|body)\s*:\s*\{\s*\.\.\.\s*(?:row|entity|record|model|instance|person|message|listing|envelope|invoice|payment|property|contract|proposal|case|user)\s*\}/;
const MAPPER_OU_PROVIDER = /^src\/features\/integrations\/(providers|minimization)\//;
const CHAMA_ENFILEIRAMENTO = /dispatchService\.enqueue|\benqueue\s*\(|callInsurer|callBankSubmit|createDispatch\s*\(/;

/**
 * Regra 5: "Não enviar DTO interno completo a portal/provider". Mappers e adapters (`providers/**`, `minimization/**`) nunca serializam o modelo inteiro (.toJSON, .dataValues, get plain, stringify de entidade);
 * e quem enfileira um envio não espalha a entidade no payload: o payload sai do mapper do port (campos nomeados, classificados e minimizados).
 */
function scan({ root = API_ROOT } = {}) {
  const achados = [];
  for (const rel of listJs(root, 'src')) {
    const linhas = codeLines(root, rel);
    const nasBordas = MAPPER_OU_PROVIDER.test(rel);
    const enfileira = linhas.some((l) => CHAMA_ENFILEIRAMENTO.test(l));
    linhas.forEach((linha, i) => {
      if (nasBordas && (SERIALIZA.test(linha) || STRINGIFY_ENTIDADE.test(linha))) achados.push(violation(5, rel, i + 1, 'Mapper ou adapter serializa a entidade interna inteira: envie só os campos nomeados pelo mapper do port.', linha));
      if ((nasBordas || enfileira) && PAYLOAD_ESPALHADO.test(linha)) achados.push(violation(5, rel, i + 1, 'A entidade interna é espalhada no payload do envio: monte o payload pelo mapper do port.', linha));
    });
  }
  return achados;
}

module.exports = { rule: 5, name: 'dto_interno_completo', scan };
