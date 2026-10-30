'use strict';

/**
 * Definição e validação das 13 etapas da esteira de CI das integrações (M9-D254, Guia §11). A ordem e os nomes são os do livro e ficam aqui, fora do arquivo de configuração:
 * um estagios.json reordenado, com etapa a menos, renomeada ou com as etapas 1 a 9 marcadas como manuais é RECUSADO antes de qualquer comando rodar. As etapas 1 a 9 rodam em todo
 * pull request e merge; 10 a 13 só em tag de release por provider, e a 13 NUNCA faz deploy: apenas habilita o botão de aprovação que o Patrick usa.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');

/** "lint → typecheck → adapter contract tests → webhook security tests → dispatch idempotency → retry/circuit tests → secret/log scan → SSRF tests → provider sandbox → DEV → LAB → failure drill → production approval". */
const ETAPAS_DO_LIVRO = Object.freeze([
  [1, 'lint'], [2, 'typecheck'], [3, 'adapter contract tests'], [4, 'webhook security tests'], [5, 'dispatch idempotency'], [6, 'retry/circuit tests'], [7, 'secret/log scan'],
  [8, 'SSRF tests'], [9, 'provider sandbox'], [10, 'DEV'], [11, 'LAB'], [12, 'failure drill'], [13, 'production approval'],
]);
const ULTIMA_DE_PR = 9;
const RELATORIOS = 'reports/int-ci';
const GUARDA = 'scripts/int-ci/offlineGuard.js';
const CODIGO_FALHA = 'INTEGRATION_CI_STAGE_FAILED';
const MENSAGEM_FALHA = 'Etapa do pipeline de integrações falhou.';

class EsteiraInvalida extends Error {}

/** Confere que a lista de etapas é exatamente a do livro. Devolve a lista de problemas (vazia = válida). */
function problemasDaDefinicao(etapas) {
  const problemas = [];
  if (!Array.isArray(etapas)) return ['etapas deve ser uma lista'];
  if (etapas.length !== ETAPAS_DO_LIVRO.length) problemas.push(`são ${etapas.length} etapas; o livro tem ${ETAPAS_DO_LIVRO.length}`);
  ETAPAS_DO_LIVRO.forEach(([numero, nome], i) => {
    const e = etapas[i];
    if (!e) { problemas.push(`etapa ${numero} (${nome}) ausente`); return; }
    if (e.numero !== numero || e.nome !== nome) problemas.push(`posição ${numero}: esperado "${nome}" (${numero}), veio "${e.nome}" (${e.numero}): a ordem do livro não pode mudar`);
    const tipoEsperado = numero <= ULTIMA_DE_PR ? 'automatica' : 'release';
    if (e.tipo !== tipoEsperado) problemas.push(`etapa ${numero} (${nome}) é "${e.tipo}"; o livro exige "${tipoEsperado}"`);
    if (!(Array.isArray(e.comandos) && e.comandos.length) && numero !== 13) problemas.push(`etapa ${numero} (${nome}) sem comando`);
    if (numero === 13 && Array.isArray(e.comandos) && e.comandos.length) problemas.push('a etapa 13 (production approval) não executa comando: só habilita a aprovação humana');
    const proibido = JSON.stringify(e.comandos || []).match(/deploy[-_ ]?(prod|production)|production[-_ ]?deploy|--prod\b/i);
    if (proibido) problemas.push(`etapa ${numero} (${nome}) tenta deploy de produção ("${proibido[0]}"): o CI nunca faz deploy em produção`);
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

/** Comandos de uma etapa: `testes` vira `node --test` com TODOS os arquivos dos padrões (nunca um recorte); sem arquivo, a esteira é recusada. */
function comandosDaEtapa(etapa, raiz = ROOT) {
  const saida = [];
  for (const c of etapa.comandos || []) {
    if (Array.isArray(c)) { saida.push({ argv: c, env: {} }); continue; }
    if (c.testes) {
      // `excluir`: prefixos de nome de arquivo que outra etapa já roda (a etapa 9 pega o resto da pasta, inclusive suítes que entrarem depois).
      const arquivos = [...new Set(c.testes.flatMap((p) => expandir(p, raiz)))].filter((f) => !(c.excluir || []).some((prefixo) => path.posix.basename(f).startsWith(prefixo)));
      if (!arquivos.length) throw new EsteiraInvalida(`etapa ${etapa.numero}: nenhum arquivo de teste para ${c.testes.join(', ')}`);
      // JUnit por comando e registro de conexões externas: a autochecagem (M9-D258) só dá "verde" ao que está no relatório consolidado de reports/offline-run.json.
      const junit = `${RELATORIOS}/etapa-${etapa.numero}-${saida.length}.xml`;
      saida.push({
        argv: ['node', '--test', '--test-concurrency=1', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', `--test-reporter-destination=${junit}`, `--require=./${GUARDA}`, ...arquivos],
        env: { NODE_ENV: 'test', INT_OFFLINE_LOG: `${RELATORIOS}/chamadas-externas.log`, ...(c.env || {}) },
      });
    } else {
      saida.push({ argv: c.argv, env: c.env || {} });
    }
  }
  return saida;
}

/** Lê e valida o arquivo de etapas. Lança EsteiraInvalida com todos os problemas. */
function carregar(arquivo) {
  const etapas = (JSON.parse(fs.readFileSync(arquivo, 'utf8')) || {}).etapas;
  const problemas = problemasDaDefinicao(etapas);
  if (problemas.length) throw new EsteiraInvalida(problemas.join('; '));
  return etapas;
}

module.exports = { ROOT, RELATORIOS, ETAPAS_DO_LIVRO, ULTIMA_DE_PR, CODIGO_FALHA, MENSAGEM_FALHA, EsteiraInvalida, problemasDaDefinicao, expandir, comandosDaEtapa, carregar };
