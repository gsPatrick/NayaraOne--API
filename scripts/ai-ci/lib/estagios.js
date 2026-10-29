'use strict';

/**
 * Definição e validação dos 16 estágios da esteira de CI da NAY (M9-D044, Guia §15). A ordem e os nomes são os do livro e ficam
 * aqui, fora do arquivo de configuração: um estagios.json reordenado, com estágio a menos, renomeado ou com os estágios 1 a 12 marcados
 * como manuais é RECUSADO antes de qualquer comando rodar.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');

/** Ordem do livro: "lint → typecheck → migrations → tool schema tests → ... → DEV → LAB → red-team → production approval". */
const ESTAGIOS_DO_LIVRO = Object.freeze([
  [1, 'lint'], [2, 'typecheck'], [3, 'migrations'], [4, 'tool schema tests'], [5, 'permission tests'], [6, 'RAG isolation tests'],
  [7, 'injection suite + adversarial'], [8, 'grounding golden set'], [9, 'hallucination tests'], [10, 'budget/router tests'],
  [11, 'provider contract tests'], [12, 'privacy/log redaction'], [13, 'DEV'], [14, 'LAB'], [15, 'red-team'], [16, 'production approval'],
]);
const ULTIMO_AUTOMATICO = 12;

class EsteiraInvalida extends Error {}

/** Confere que a lista de estágios é exatamente a do livro. Devolve a lista de problemas (vazia = válida). */
function problemasDaDefinicao(estagios) {
  const problemas = [];
  if (!Array.isArray(estagios)) return ['estagios deve ser uma lista'];
  if (estagios.length !== ESTAGIOS_DO_LIVRO.length) problemas.push(`são ${estagios.length} estágios; o livro tem ${ESTAGIOS_DO_LIVRO.length}`);
  ESTAGIOS_DO_LIVRO.forEach(([numero, nome], i) => {
    const e = estagios[i];
    if (!e) { problemas.push(`estágio ${numero} (${nome}) ausente`); return; }
    if (e.numero !== numero || e.nome !== nome) problemas.push(`posição ${numero}: esperado "${nome}" (${numero}), veio "${e.nome}" (${e.numero}): ordem do livro não pode mudar`);
    const tipoEsperado = numero <= ULTIMO_AUTOMATICO ? 'automatico' : 'registro';
    if (e.tipo !== tipoEsperado) problemas.push(`estágio ${numero} (${nome}) é "${e.tipo}"; o livro exige "${tipoEsperado}"${numero <= ULTIMO_AUTOMATICO ? ' (nenhum de 1 a 12 pode ser manual)' : ''}`);
    if (e.tipo === 'automatico' && !(Array.isArray(e.comandos) && e.comandos.length)) problemas.push(`estágio ${numero} (${nome}) sem comando`);
    if (e.tipo === 'registro' && !e.item) problemas.push(`estágio ${numero} (${nome}) sem item de ai.release_gates`);
  });
  return problemas;
}

/** Expande um padrão simples (`*` no nome do arquivo) relativo à raiz da API; ordem alfabética, sem repetir. */
function expandir(padrao, raiz = ROOT) {
  if (!padrao.includes('*')) return [padrao];
  const dir = path.dirname(padrao);
  const re = new RegExp(`^${path.basename(padrao).split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  const abs = path.join(raiz, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter((f) => re.test(f)).sort().map((f) => path.posix.join(dir, f));
}

/** Comandos de um estágio automático: `testes` vira `node --test` com todos os arquivos dos padrões (nunca um recorte). */
function comandosDoEstagio(estagio, raiz = ROOT) {
  const saida = [];
  for (const c of estagio.comandos) {
    if (Array.isArray(c)) { saida.push({ argv: c, env: {} }); continue; }
    if (c.testes) {
      const arquivos = [...new Set(c.testes.flatMap((p) => expandir(p, raiz)))];
      if (!arquivos.length) throw new EsteiraInvalida(`estágio ${estagio.numero}: nenhum arquivo de teste para ${c.testes.join(', ')}`);
      saida.push({ argv: ['node', '--test', '--test-concurrency=1', '--test-reporter=spec', ...arquivos], env: { NODE_ENV: 'test', ...(c.env || {}) } });
    } else {
      saida.push({ argv: c.argv, env: c.env || {} });
    }
  }
  return saida;
}

function carregar(arquivo) {
  const definicao = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  const problemas = problemasDaDefinicao(definicao.estagios);
  if (problemas.length) throw new EsteiraInvalida(`definição da esteira recusada:\n- ${problemas.join('\n- ')}`);
  return definicao.estagios;
}

module.exports = { ROOT, ESTAGIOS_DO_LIVRO, ULTIMO_AUTOMATICO, EsteiraInvalida, problemasDaDefinicao, expandir, comandosDoEstagio, carregar };
