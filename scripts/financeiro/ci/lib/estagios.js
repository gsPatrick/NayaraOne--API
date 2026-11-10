'use strict';

/**
 * Definição e validação dos 17 estágios da esteira de CI do Financeiro (Marco 4, Guia do Marcelo §17 "CI/CD financeiro"). A ordem e os nomes são os do
 * livro e ficam aqui, fora do arquivo de configuração: um estagios.json reordenado, com estágio a menos, renomeado ou com tipo trocado é RECUSADO antes de
 * qualquer comando rodar. Estágios 1 a 13, 15 e 16 rodam em todo push e pull request (o 13, deploy_DEV, sobe a API do HEAD num banco descartável e confere
 * a saúde); o 14 (deploy_LAB) só em branch de entrega; o 17 (production_approval) só depois da aprovação manual do environment "production" e NUNCA faz
 * deploy: confere o portão e registra a aprovação; quem publica é o Patrick.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const RELATORIOS = 'reports/fin-ci';

/** Guia §17: "lint, typecheck, unit_tests, db_migrations, finance_integration_tests, concurrency_tests, idempotency_tests, bank_adapter_contract_tests,
 * reconciliation_tests, closed_period_tests, multi_company_tests, security_scan, deploy_DEV, deploy_LAB, failure_drills, pentest, production_approval". */
const ESTAGIOS_DO_LIVRO = Object.freeze([
  [1, 'lint'], [2, 'typecheck'], [3, 'unit_tests'], [4, 'db_migrations'], [5, 'finance_integration_tests'], [6, 'concurrency_tests'], [7, 'idempotency_tests'],
  [8, 'bank_adapter_contract_tests'], [9, 'reconciliation_tests'], [10, 'closed_period_tests'], [11, 'multi_company_tests'], [12, 'security_scan'],
  [13, 'deploy_DEV'], [14, 'deploy_LAB'], [15, 'failure_drills'], [16, 'pentest'], [17, 'production_approval'],
]);
const TIPO_DO_LIVRO = (numero) => (numero === 14 ? 'entrega' : numero === 17 ? 'aprovacao' : 'push');
const CODIGO_FALHA = 'FIN_CI_STAGE_FAILED';
const MENSAGEM_FALHA = 'Um estágio do pipeline financeiro falhou; a entrega está bloqueada.';

class EsteiraInvalida extends Error {}

/** Confere que a lista de estágios é exatamente a do livro. Devolve a lista de problemas (vazia = válida). */
function problemasDaDefinicao(estagios) {
  const problemas = [];
  if (!Array.isArray(estagios)) return ['estagios deve ser uma lista'];
  if (estagios.length !== ESTAGIOS_DO_LIVRO.length) problemas.push(`são ${estagios.length} estágios; o livro tem ${ESTAGIOS_DO_LIVRO.length}`);
  ESTAGIOS_DO_LIVRO.forEach(([numero, nome], i) => {
    const e = estagios[i];
    if (!e) { problemas.push(`estágio ${numero} (${nome}) ausente`); return; }
    if (e.numero !== numero || e.nome !== nome) problemas.push(`posição ${numero}: esperado "${nome}" (${numero}), veio "${e.nome}" (${e.numero}): a ordem do livro não pode mudar`);
    if (e.tipo !== TIPO_DO_LIVRO(numero)) problemas.push(`estágio ${numero} (${nome}) é "${e.tipo}"; o esperado é "${TIPO_DO_LIVRO(numero)}" (1 a 13, 15 e 16 em todo push; 14 em entrega; 17 após aprovação manual)`);
    if (!(Array.isArray(e.comandos) && e.comandos.length)) problemas.push(`estágio ${numero} (${nome}) sem comando`);
    const proibido = JSON.stringify(e.comandos || []).match(/deploy[-_ ]?(prod|production)|production[-_ ]?deploy|PRODUCTION_API_DEPLOY_HOOK|--prod\b/i);
    if (proibido) problemas.push(`estágio ${numero} (${nome}) tenta deploy de produção ("${proibido[0]}"): o CI nunca faz deploy em produção`);
  });
  return problemas;
}

/** Expande um padrão simples (`*` no nome do arquivo) relativo à raiz da API; ordem alfabética, sem repetir. */
function expandir(padrao, raiz = ROOT) {
  if (!padrao.includes('*')) return fs.existsSync(path.join(raiz, padrao)) ? [padrao] : [];
  const dir = path.dirname(padrao);
  const re = new RegExp(`^${path.basename(padrao).split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  const abs = path.join(raiz, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter((f) => re.test(f)).sort().map((f) => path.posix.join(dir, f));
}

/** Troca ${VAR} por process.env.VAR (só nomes FIN_CI_*); sem valor, a esteira é recusada. */
function interpolar(argv, env = process.env) {
  return argv.map((a) => a.replace(/\$\{(FIN_CI_[A-Z0-9_]+)\}/g, (_, nome) => {
    if (!env[nome]) throw new EsteiraInvalida(`variável ${nome} não definida (o script scripts/ci-estagios-financeiro.sh a define)`);
    return env[nome];
  }));
}

/** Comandos de um estágio: `testes` vira `node --test` com TODOS os arquivos dos padrões (nunca um recorte); padrão sem arquivo = esteira recusada. */
function comandosDaEtapa(estagio, raiz = ROOT, env = process.env) {
  const saida = [];
  for (const c of estagio.comandos || []) {
    if (Array.isArray(c)) { saida.push({ argv: interpolar(c, env), env: {} }); continue; }
    if (!c.testes) throw new EsteiraInvalida(`estágio ${estagio.numero}: comando sem argv nem testes`);
    const arquivos = [];
    for (const p of c.testes) {
      const achados = expandir(p, raiz);
      if (!achados.length) throw new EsteiraInvalida(`estágio ${estagio.numero}: nenhum arquivo de teste para ${p}`);
      arquivos.push(...achados);
    }
    const junit = `${RELATORIOS}/estagio-${estagio.numero}-${saida.length}.xml`;
    saida.push({
      argv: ['node', '--test', '--test-concurrency=1', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', `--test-reporter-destination=${junit}`, ...new Set(arquivos)],
      env: { NODE_ENV: 'test', ...(c.env || {}) },
    });
  }
  return saida;
}

/** Nomes de teste exigidos (`exigidos`) que não aparecem em nenhum arquivo dos padrões do estágio. Apagar ou renomear um deles reprova o estágio. */
function testesExigidosAusentes(estagio, raiz = ROOT) {
  const exigidos = estagio.exigidos || [];
  if (!exigidos.length) return [];
  const arquivos = [...new Set((estagio.comandos || []).filter((c) => c && c.testes).flatMap((c) => c.testes.flatMap((p) => expandir(p, raiz))))];
  const texto = arquivos.map((f) => fs.readFileSync(path.join(raiz, f), 'utf8')).join('\n');
  return exigidos.filter((nome) => !texto.includes(nome));
}

/** Lê e valida o arquivo de estágios. Lança EsteiraInvalida com todos os problemas. */
function carregar(arquivo) {
  const estagios = (JSON.parse(fs.readFileSync(arquivo, 'utf8')) || {}).estagios;
  const problemas = problemasDaDefinicao(estagios);
  if (problemas.length) throw new EsteiraInvalida(problemas.join('; '));
  return estagios;
}

module.exports = {
  ROOT, RELATORIOS, ESTAGIOS_DO_LIVRO, TIPO_DO_LIVRO, CODIGO_FALHA, MENSAGEM_FALHA, EsteiraInvalida,
  problemasDaDefinicao, expandir, interpolar, comandosDaEtapa, testesExigidosAusentes, carregar,
};
