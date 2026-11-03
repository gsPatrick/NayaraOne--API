'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { LeituraError } = require('./erros');
const { RAIZ_API } = require('./config');

/** Padrão de UM nome de arquivo (`*`, `?` e classes `[0-5]`) para expressão regular; o resto é literal. */
function nomeParaRegex(nome) {
  let re = '';
  for (let i = 0; i < nome.length; i += 1) {
    const c = nome[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[' && nome.indexOf(']', i) > i) { const fim = nome.indexOf(']', i); re += nome.slice(i, fim + 1); i = fim; } else re += c.replace(/[.+^${}()|\\\]]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * Expande os padrões de teste da configuração SEM depender do shell nem do `node --test` (o Node 20 do CI não expande glob; só a partir do 21): o curinga vale só no último
 * trecho do caminho (o nome do arquivo). Caminho sem curinga tem de existir. Padrão sem nenhum arquivo = erro de leitura (nunca suíte vazia "verde"). Devolve caminhos relativos à raiz da API, ordenados.
 */
function expandirGlobs(padroes, raiz = RAIZ_API) {
  const arquivos = [];
  for (const padrao of padroes) {
    const dir = path.dirname(padrao);
    const nome = path.basename(padrao);
    if (!/[*?[]/.test(nome)) {
      if (!fs.existsSync(path.resolve(raiz, padrao))) throw new LeituraError(`arquivo de teste inexistente: ${padrao}`);
      arquivos.push(padrao);
      continue;
    }
    let lista;
    try { lista = fs.readdirSync(path.resolve(raiz, dir)); } catch (e) { throw new LeituraError(`não foi possível listar ${dir} para o padrão ${padrao}: ${e.code || e.message}`); }
    const re = nomeParaRegex(nome);
    const achados = lista.filter((n) => re.test(n)).sort().map((n) => path.join(dir, n));
    if (!achados.length) throw new LeituraError(`o padrão de teste ${padrao} não encontrou nenhum arquivo`);
    arquivos.push(...achados);
  }
  return [...new Set(arquivos)];
}

module.exports = { expandirGlobs, nomeParaRegex };
