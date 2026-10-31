'use strict';

const { LeituraError, CODIGO_ITEM, CODIGO_INVALIDO, mensagemItem, MENSAGEM_INVALIDO } = require('./erros');

/** As provas do fechamento, na ordem do livro: as cinco do DoD e a conferência dos nove testes nomeados (§3.2b). */
const ITENS = {
  dry3: require('./dry3'),
  registry: require('./registry'),
  lineage: require('./lineage'),
  dlp: require('./dlp'),
  manifest: require('./manifest'),
  adversarial: require('./adversarial'),
};

/**
 * Executa as provas escolhidas. Cada uma devolve { nome, ok, motivo }; erro de leitura vira { erro: true }. Uma prova que quebra não impede as outras de rodar
 * (o relatório mostra todas). `codigo`: 0 só com todas OK; 2 se alguma não pôde ser lida; 1 se alguma falhou.
 */
async function executar({ cfg, chaves = Object.keys(ITENS) }) {
  const resultados = [];
  for (const chave of chaves) {
    const item = ITENS[chave];
    try { resultados.push({ chave, ...(await item.verificar({ cfg })) }); } catch (e) {
      if (!(e instanceof LeituraError)) throw e;
      resultados.push({ chave, nome: item.NOME, ok: false, erro: true, motivo: e.message });
    }
  }
  const codigo = resultados.some((r) => r.erro) ? 2 : resultados.every((r) => r.ok) ? 0 : 1;
  return { resultados, codigo };
}

/** Linhas do relatório: uma por item, `OK` ou `FALHA <motivo>`. */
const linhas = (resultados) => resultados.map((r) => (r.ok ? `OK ${r.nome}: ${r.motivo}` : `${r.erro ? 'ERRO' : 'FALHA'} ${r.nome}: ${r.motivo}`));

function mensagensDeErro(resultados) {
  const falhas = resultados.filter((r) => !r.ok && !r.erro).map((r) => `${CODIGO_ITEM}: ${mensagemItem(r.nome)}`);
  const erros = resultados.filter((r) => r.erro);
  return erros.length ? [`${CODIGO_INVALIDO}: ${MENSAGEM_INVALIDO}`, ...erros.map((r) => `  ${r.nome}: ${r.motivo}`), ...falhas] : falhas;
}

module.exports = { executar, linhas, mensagensDeErro, ITENS };
