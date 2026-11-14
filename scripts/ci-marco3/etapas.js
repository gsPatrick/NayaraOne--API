'use strict';

/**
 * As 17 etapas do CI/CD do Guia do Marcelo do Marco 3 (§16), nesta ordem e com estes nomes literais. A ordem, os nomes e o tipo de cada
 * etapa ficam AQUI, fora do arquivo de configuração (scripts/ci-marco3/etapas.json, que só diz o que cada etapa roda): um etapas.json
 * reordenado, com etapa a menos, renomeada, com tipo trocado ou com deploy de produção é RECUSADO (M3_CI_STAGES_MISMATCH) antes de
 * qualquer comando rodar. Tipos: push (todo push e pull request), release (deploy_DEV e deploy_LAB, só em tag m3-release-*; fora dela
 * NAO_APLICAVEL), aprovacao (production_approval, só em tag, atrás do environment com revisor; nunca faz deploy).
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG = path.join(__dirname, 'etapas.json');
const CODIGO_DEFINICAO = 'M3_CI_STAGES_MISMATCH';
const CODIGO_FALHA = 'M3_CI_STAGE_FAILED';
const TAG_RELEASE = 'm3-release-';

/** Guia M3 §16, literal. */
const NOMES_DO_LIVRO = Object.freeze([
  'lint', 'typecheck', 'migrations', 'people_dedup_tests', 'merge_tests', 'property_offer_tests', 'publication_gate_tests', 'crm_invariant_tests',
  'radar_idempotency_tests', 'consent_tests', 'ai_grounding_tests', 'multi_company_tests', 'security_scan', 'deploy_DEV', 'deploy_LAB', 'load_tests',
  'production_approval',
]);
const TIPO_DO_LIVRO = (nome) => (nome === 'deploy_DEV' || nome === 'deploy_LAB' ? 'release' : nome === 'production_approval' ? 'aprovacao' : 'push');
const DEPLOY_PRODUCAO = /deploy[-_ ]?(prod|production)|production[-_ ]?deploy|PRODUCTION_API_DEPLOY_HOOK|--prod\b/i;

class EsteiraInvalida extends Error {
  constructor(mensagem) { super(`${CODIGO_DEFINICAO}: ${mensagem}`); this.code = CODIGO_DEFINICAO; }
}

/** Lista de problemas da definição (vazia = é exatamente a do livro). */
function problemasDaDefinicao(etapas) {
  if (!Array.isArray(etapas)) return ['etapas deve ser uma lista'];
  const problemas = [];
  if (etapas.length !== NOMES_DO_LIVRO.length) problemas.push(`são ${etapas.length} etapas; o livro tem ${NOMES_DO_LIVRO.length}`);
  NOMES_DO_LIVRO.forEach((nome, i) => {
    const e = etapas[i];
    const numero = i + 1;
    if (!e) { problemas.push(`etapa ${numero} (${nome}) ausente`); return; }
    if (e.numero !== numero || e.nome !== nome) problemas.push(`posição ${numero}: esperado "${nome}", veio "${e.nome}" (${e.numero}); a ordem e o nome do livro não mudam`);
    if (e.tipo !== TIPO_DO_LIVRO(nome)) problemas.push(`etapa ${numero} (${nome}) é "${e.tipo}"; o esperado é "${TIPO_DO_LIVRO(nome)}"`);
    if (!(Array.isArray(e.comandos) && e.comandos.length)) problemas.push(`etapa ${numero} (${nome}) sem comando`);
    const proibido = JSON.stringify(e.comandos || []).match(DEPLOY_PRODUCAO);
    if (proibido) problemas.push(`etapa ${numero} (${nome}) tenta deploy de produção ("${proibido[0]}"): o CI nunca publica produção`);
  });
  return problemas;
}

/** Expande `test/dir/prefixo*.test.js` (o `*` só no nome do arquivo), em ordem alfabética. */
function expandir(padrao, raiz = ROOT) {
  if (!padrao.includes('*')) return fs.existsSync(path.join(raiz, padrao)) ? [padrao] : [];
  const dir = path.posix.dirname(padrao);
  const re = new RegExp(`^${path.posix.basename(padrao).split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  const abs = path.join(raiz, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter((f) => re.test(f)).sort().map((f) => path.posix.join(dir, f));
}

/** Expande os padrões de um comando `{ testes }`. Padrão sem arquivo = esteira recusada. */
function expandirTestes(etapa, padroes, raiz) {
  return [...new Set(padroes.flatMap((p) => {
    const achados = expandir(p, raiz);
    if (!achados.length) throw new EsteiraInvalida(`etapa ${etapa.numero} (${etapa.nome}): nenhum arquivo de teste para ${p}`);
    return achados;
  }))];
}

/** Arquivos de teste de uma etapa (todos os padrões expandidos, sem repetir). */
function arquivosDeTeste(etapa, raiz = ROOT) {
  const padroes = (etapa.comandos || []).filter((c) => c && !Array.isArray(c)).flatMap((c) => c.testes || []);
  return expandirTestes(etapa, padroes, raiz);
}

/** Comandos (argv) de uma etapa: `{ testes }` vira `node --test --test-concurrency=1` com TODOS os arquivos dos padrões. */
function comandosDaEtapa(etapa, raiz = ROOT) {
  return (etapa.comandos || []).map((c) => {
    if (Array.isArray(c)) return c;
    if (!c || !Array.isArray(c.testes)) throw new EsteiraInvalida(`etapa ${etapa.numero} (${etapa.nome}): comando sem argv nem testes`);
    return ['node', '--test', '--test-concurrency=1', ...expandirTestes(etapa, c.testes, raiz)];
  });
}

/** Nomes exigidos que não aparecem em nenhum arquivo de teste da etapa (apagar ou renomear um deles reprova a etapa). */
function testesExigidosAusentes(etapa, raiz = ROOT) {
  const exigidos = etapa.exigidos || [];
  if (!exigidos.length) return [];
  const texto = arquivosDeTeste(etapa, raiz).map((f) => fs.readFileSync(path.join(raiz, f), 'utf8')).join('\n');
  return exigidos.filter((nome) => !texto.includes(nome));
}

/** Lê e valida o arquivo de configuração. Lança EsteiraInvalida com todos os problemas. */
function carregar(arquivo = CONFIG) {
  const config = JSON.parse(fs.readFileSync(arquivo, 'utf8')) || {};
  const problemas = problemasDaDefinicao(config.etapas);
  if (problemas.length) throw new EsteiraInvalida(problemas.join('; '));
  return config;
}

module.exports = {
  ROOT, CONFIG, CODIGO_DEFINICAO, CODIGO_FALHA, TAG_RELEASE, NOMES_DO_LIVRO, TIPO_DO_LIVRO, EsteiraInvalida,
  problemasDaDefinicao, expandir, arquivosDeTeste, comandosDaEtapa, testesExigidosAusentes, carregar,
};
