'use strict';

// Árvores de código sintéticas das guardas do "Não improvisar" (M9-D257): cada teste monta uma raiz temporária com o arquivo que viola a regra e prova que a guarda FALHA, com arquivo e linha.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Cria uma raiz temporária com os arquivos { 'caminho/relativo': 'conteúdo' } e devolve a raiz. */
function arvore(arquivos) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d257-'));
  for (const [rel, conteudo] of Object.entries(arquivos)) {
    const alvo = path.join(raiz, rel);
    fs.mkdirSync(path.dirname(alvo), { recursive: true });
    fs.writeFileSync(alvo, conteudo);
  }
  return raiz;
}

/** Segredo fictício montado em tempo de execução: nenhum arquivo versionado carrega o padrão inteiro. */
const chaveAws = () => ['AK', 'IA', 'A'.repeat(16)].join('');

module.exports = { arvore, chaveAws };
