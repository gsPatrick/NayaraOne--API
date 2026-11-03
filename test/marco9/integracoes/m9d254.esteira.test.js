'use strict';

// Marco 9, M9-D254 — a esteira de CI das integrações: as 13 etapas na ordem do livro, parando na primeira vermelha, com as suítes de nomes adversariais (D251) e o Definition of Done (D253)
// na etapa 9. Sem banco: o runner roda etapas de brinquedo como processo; a configuração real é lida e conferida.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { RAIZ, etapasDeBrinquedo, executar, lerEtapas, E } = require('../_helpers/m9d254Esteira');

const NOMES = ['lint', 'typecheck', 'adapter contract tests', 'webhook security tests', 'dispatch idempotency', 'retry/circuit tests', 'secret/log scan', 'SSRF tests', 'provider sandbox', 'DEV', 'LAB', 'failure drill', 'production approval'];

test('ci_ordem_das_etapas_conforme_livro', () => {
  const etapas = lerEtapas();
  assert.deepEqual(etapas.map((e) => e.nome), NOMES, 'as 13 etapas, na ordem e com os nomes do livro');
  assert.deepEqual(etapas.map((e) => e.numero), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.deepEqual(E.problemasDaDefinicao(etapas), []);
  // Cada etapa de 1 a 9 tem o comando do livro; todos os arquivos de teste dos padrões existem (nada recortado).
  const comando = (n) => JSON.stringify(etapas[n - 1].comandos);
  assert.match(comando(1), /"lint"/);
  assert.match(comando(2), /"typecheck"/);
  assert.match(comando(3), /m9d222/);
  assert.match(comando(4), /m9d211/);
  assert.match(comando(4), /m9d213/);
  assert.match(comando(5), /m9d214/);
  assert.match(comando(5), /m9d215/);
  assert.match(comando(6), /m9d216/);
  assert.match(comando(6), /m9d218/);
  assert.match(comando(7), /scan:secrets/);
  assert.match(comando(7), /redaction\.canary/);
  assert.match(comando(8), /m9d245/);
  for (const e of etapas.filter((x) => x.numero <= 9)) assert.ok(E.comandosDaEtapa(e).length > 0, `etapa ${e.numero} sem comando`);
  assert.equal(JSON.parse(require('node:fs').readFileSync(path.join(RAIZ, 'scripts/int-ci/estagios.json'), 'utf8')).linguagem, 'javascript', 'integration.module.language: o repositório é JavaScript');
  // Reordenar, renomear, faltar etapa ou tornar manual uma das 1 a 9 é recusado antes de rodar qualquer coisa.
  const trocadas = [...etapas]; [trocadas[2], trocadas[3]] = [trocadas[3], trocadas[2]];
  assert.ok(E.problemasDaDefinicao(trocadas).length > 0, 'ordem trocada');
  assert.ok(E.problemasDaDefinicao(etapas.map((e) => (e.numero === 5 ? { ...e, nome: 'idempotência' } : e))).length > 0, 'nome trocado');
  assert.ok(E.problemasDaDefinicao(etapas.slice(0, 12)).length > 0, 'etapa faltando');
  assert.ok(E.problemasDaDefinicao(etapas.map((e) => (e.numero === 4 ? { ...e, tipo: 'release' } : e))).length > 0, 'etapa de pull request virando de release');
  const r = executar(etapasDeBrinquedo().reverse());
  assert.equal(r.status, 2);
  assert.deepEqual(r.marcas, [], 'esteira inválida não roda comando nenhum');
});

test('ci_falha_em_uma_etapa_bloqueia_as_seguintes', () => {
  const r = executar(etapasDeBrinquedo({ 3: { comandos: [require('../_helpers/m9d254Esteira').marcar(3, 1)] } }));
  assert.equal(r.status, 1);
  assert.deepEqual(r.marcas, [1, 2, 3], 'a etapa 3 falhou: as etapas 4 a 9 não rodam');
  assert.match(r.saida, /INTEGRATION_CI_STAGE_FAILED Etapa do pipeline de integrações falhou\./);
  assert.deepEqual(r.relatorio.etapas.map((e) => e.status), ['VERDE', 'VERDE', 'VERMELHO', 'NAO_RODOU', 'NAO_RODOU', 'NAO_RODOU', 'NAO_RODOU', 'NAO_RODOU', 'NAO_RODOU']);
  assert.equal(r.relatorio.etapas[2].codigo, 'INTEGRATION_CI_STAGE_FAILED');
  assert.equal(r.relatorio.resultado, 'VERMELHO');
  // Tudo verde: as nove rodam em ordem e o resultado é verde.
  const ok = executar(etapasDeBrinquedo());
  assert.equal(ok.status, 0);
  assert.deepEqual(ok.marcas, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // A etapa 9 vermelha também bloqueia o que viria depois dela numa tag de release.
  const rel = executar(etapasDeBrinquedo({ 10: { comandos: [require('../_helpers/m9d254Esteira').marcar(10, 1)] } }), ['--release'], { INT_CI_PROVIDER: 'messaging-sandbox' });
  assert.equal(rel.status, 1);
  assert.deepEqual(rel.marcas, [10], 'DEV vermelho: LAB, failure drill e aprovação não rodam');
  assert.equal(rel.relatorio.etapas.at(-1).status, 'NAO_RODOU');
});

test('ci_verifica_15_itens_e_18_nomes_adversariais', () => {
  const etapa9 = lerEtapas().find((e) => e.numero === 9);
  const argvs = etapa9.comandos.filter(Array.isArray).map((c) => c.join(' '));
  assert.ok(argvs.includes('node scripts/checkAdversarialNames.js'), 'a etapa 9 roda o verificador de nomes da D251 (15 itens do livro e 18 nomes)');
  // O verificador é um passo próprio da etapa: se ele sair com erro, a etapa 9 fica vermelha e a esteira para.
  const r = executar(etapasDeBrinquedo({ 9: { comandos: [require('../_helpers/m9d254Esteira').marcar(9, 1)] } }));
  assert.equal(r.status, 1);
  assert.match(r.saida, /etapa 9: provider sandbox/);
  assert.equal(r.relatorio.etapas.at(-1).status, 'VERMELHO');
  // As suítes adversariais ficam FORA das etapas 1 a 3 e não são recortadas: a etapa 9 pega todos os arquivos da pasta de integrações que as etapas 3 a 8 não rodam.
  const pegos = E.comandosDaEtapa(etapa9).find((c) => c.argv[0] === 'node' && c.argv[1] === '--test').argv.filter((a) => a.endsWith('.test.js'));
  assert.ok(pegos.length > 50);
  assert.ok(!pegos.some((a) => /m9d21[1-8]\.|m9d222\.|m9d245\./.test(a)), 'sem repetir o que as etapas 3 a 8 rodam');
  assert.ok(pegos.some((a) => a.includes('m9d229.')) && pegos.some((a) => a.includes('m9d230.')), 'os sandboxes de ponta a ponta entram');
});

test('ci_executa_dod', () => {
  const etapa9 = lerEtapas().find((e) => e.numero === 9);
  const argvs = etapa9.comandos.filter(Array.isArray).map((c) => c.join(' '));
  assert.ok(argvs.includes('node scripts/integrationDod.js'), 'a etapa 9 roda o Definition of Done da D253');
  // O Definition of Done vermelho reprova a esteira (exit 1 do script).
  const so9 = (codigo) => executar(etapasDeBrinquedo({ 9: { comandos: [['node', '-e', `process.exit(${codigo})`]] } }));
  assert.equal(so9(1).status, 1);
  assert.equal(so9(0).status, 0);
});

test('ci_usa_banco_descartavel', () => {
  const fs = require('node:fs');
  const sh = fs.readFileSync(path.join(RAIZ, 'scripts/ci-estagios-integracoes.sh'), 'utf8');
  assert.match(sh, /scripts\/withDisposableDb\.js/);
  assert.doesNotMatch(sh.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n'), /\.env|DATABASE_URL|DB_HOST|DB_NAME/, 'o wrapper nunca lê o .env nem aponta para um banco');
  const yml = fs.readFileSync(path.join(RAIZ, '.github/workflows/integracoes-esteira.yml'), 'utf8');
  assert.doesNotMatch(yml, /postgres/i, 'o workflow não sobe nem aponta um banco compartilhado');
  assert.match(yml, /ci-estagios-integracoes\.sh/);
  // Toda etapa de 3 a 9 declara banco e o runner RECUSA rodar fora de banco descartável.
  const etapas = lerEtapas();
  assert.ok(etapas.filter((e) => e.numero >= 3 && e.numero <= 9).every((e) => e.banco === true));
  const comBanco = etapasDeBrinquedo({ 3: { banco: true } });
  const recusada = executar(comBanco);
  assert.equal(recusada.status, 1);
  assert.deepEqual(recusada.marcas, [1, 2], 'a etapa 3 de banco foi recusada fora do banco descartável');
  assert.match(recusada.saida, /RECUSADO: etapa de banco só roda em banco descartável/);
  const liberada = executar(comBanco, [], { DISPOSABLE_DB: '1' });
  assert.equal(liberada.status, 0);
});

test('ci_sem_deploy_de_producao', () => {
  const fs = require('node:fs');
  const yaml = require('js-yaml');
  const wf = yaml.load(fs.readFileSync(path.join(RAIZ, '.github/workflows/integracoes-esteira.yml'), 'utf8'));
  const passos = Object.values(wf.jobs).flatMap((j) => j.steps || []);
  const comandos = passos.map((p) => String(p.run || '')).join('\n');
  // O único deploy que o CI faz é para DEV e LAB (ganchos do cofre); nada de produção.
  const deploys = comandos.split('\n').filter((l) => /curl/.test(l));
  assert.equal(deploys.length, 2);
  assert.ok(deploys.every((l) => /INT_CI_(DEV|LAB)_DEPLOY_HOOK/.test(l)));
  assert.doesNotMatch(JSON.stringify(wf), /PROD_|_PROD|production_deploy|deploy_production|environment":"production/i);
  // A etapa 13 é um job com ambiente de aprovação (revisor humano) que não executa deploy: só roda o runner na etapa 13.
  const aprovacao = wf.jobs['aprovacao-humana'];
  assert.equal(aprovacao.environment, 'integracoes-aprovacao');
  assert.ok(aprovacao.steps.every((p) => !/curl|deploy/i.test(String(p.run || ''))));
  // O runner na etapa 13 não executa comando algum e marca AGUARDANDO_APROVACAO; a definição recusa deploy de produção em qualquer etapa.
  const r = executar(etapasDeBrinquedo(), ['--release', '--de', '13', '--ate', '13'], { INT_CI_PROVIDER: 'messaging-sandbox' });
  assert.equal(r.status, 0);
  assert.deepEqual(r.marcas, []);
  assert.equal(r.relatorio.etapas[0].status, 'AGUARDANDO_APROVACAO');
  assert.equal(r.relatorio.aprovacaoHabilitada, true);
  assert.match(r.saida, /não faz deploy em produção/);
  const comDeploy = etapasDeBrinquedo({ 12: { comandos: [['sh', '-c', 'deploy-production --tag x']] } });
  assert.ok(E.problemasDaDefinicao(comDeploy).some((p) => /deploy de produção/.test(p)));
  assert.equal(executar(comDeploy, ['--release']).status, 2);
  assert.ok(E.problemasDaDefinicao(etapasDeBrinquedo({ 13: { comandos: [['echo', 'x']] } })).length > 0, 'a etapa 13 não executa comando');
});

test('ci_typecheck_confere_os_ports_e_falha_com_erro_de_tipo', () => {
  const ok = spawnSync('npm', ['run', '--silent', 'typecheck'], { cwd: RAIZ, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d254-ts-'));
  fs.writeFileSync(path.join(dir, 'ruim.js'), '/** @param {string} a */\nfunction f(a) { return a.naoExiste.x; }\nf(3);\n');
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { allowJs: true, checkJs: true, noEmit: true, strict: true, noResolve: true, types: [] }, files: ['ruim.js'] }));
  const ruim = spawnSync(path.join(RAIZ, 'node_modules', '.bin', 'tsc'), ['--noEmit', '--allowJs', '--checkJs', '-p', path.join(dir, 'tsconfig.json')], { encoding: 'utf8' });
  assert.notEqual(ruim.status, 0, 'erro de tipo reprova o typecheck');
});

test('runner_de_brinquedo_nao_apaga_os_junit_reais_da_etapa_em_curso', () => {
  // A etapa 9 roda este arquivo dentro de reports/int-ci/: o runner de brinquedo (que zera a pasta de relatórios ao começar na etapa 3 ou antes) apagava os JUnit reais e
  // o offlineRelatorio da própria etapa terminava em "sem JUnit". Agora o brinquedo usa uma pasta própria (INT_CI_PASTA_RELATORIOS).
  const fs = require('node:fs');
  const real = path.join(RAIZ, E.RELATORIOS);
  fs.mkdirSync(real, { recursive: true });
  const sentinela = path.join(real, `m9d254-sentinela-${process.pid}.xml`);
  fs.writeFileSync(sentinela, '<testsuites/>');
  try {
    assert.equal(executar(etapasDeBrinquedo()).status, 0);
    assert.ok(fs.existsSync(sentinela), 'o runner de brinquedo não pode apagar a pasta de relatórios real');
  } finally { fs.rmSync(sentinela, { force: true }); }
});
