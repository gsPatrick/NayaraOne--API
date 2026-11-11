'use strict';

/**
 * Guia do Marcelo do Marco 3, §16 (CI/CD): a esteira do Marco 3 tem as 17 etapas com os nomes literais do livro, nesta ordem, no arquivo
 * de configuração, no script e no workflow; toda etapa de teste aponta para arquivos que existem; o executor para na primeira vermelha,
 * grava o relatório por etapa, deixa deploy_DEV/deploy_LAB/production_approval NAO_APLICAVEL fora da tag de release e nunca roda etapa de
 * banco fora do banco descartável; production_approval fica atrás do environment com revisor e nenhum passo publica produção; a carga
 * confere as invariantes do livro. Teste sem banco (o executor roda com uma configuração de comandos triviais).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const E = require('../scripts/ci-marco3/etapas');
const { problemas: problemasDoPortao } = require('../scripts/ci-marco3/aprovacao');
const inv = require('../scripts/m3-load/invariantes');
const { validarVolume } = require('../scripts/m3-load/executar');
const { exigirBancoDescartavel } = require('../scripts/loadTestMarco3');

const ROOT = path.resolve(__dirname, '..');
const LIVRO = ['lint', 'typecheck', 'migrations', 'people_dedup_tests', 'merge_tests', 'property_offer_tests', 'publication_gate_tests', 'crm_invariant_tests',
  'radar_idempotency_tests', 'consent_tests', 'ai_grounding_tests', 'multi_company_tests', 'security_scan', 'deploy_DEV', 'deploy_LAB', 'load_tests', 'production_approval'];
const CADERNO = path.resolve(ROOT, '..', 'Maturacao', 'MARCO_3_CADERNO_COMPLETO.md');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'marco3-esteira.yml');
const config = () => JSON.parse(fs.readFileSync(E.CONFIG, 'utf8'));
const emOrdem = (texto, nomes) => new RegExp(nomes.map((n) => `\\b${n}\\b`).join('[\\s\\S]*?')).test(texto);

function executar(etapas, args, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3ci-'));
  const arquivo = path.join(dir, 'etapas.json');
  fs.writeFileSync(arquivo, JSON.stringify({ etapas }));
  const relatorio = path.join(dir, 'relatorio.json');
  const baseEnv = { ...process.env, DISPOSABLE_DB: '', GITHUB_ACTIONS: '', GITHUB_SHA: '', ...env };
  const r = spawnSync(process.execPath, ['scripts/ci-marco3/executar.js', '--config', arquivo, '--relatorio', relatorio, ...args], { cwd: ROOT, encoding: 'utf8', env: baseEnv });
  return { status: r.status, saida: r.stdout + r.stderr, rel: JSON.parse(fs.readFileSync(relatorio, 'utf8')), dir };
}
/** Configuração com os nomes e tipos do livro e comandos triviais (node -e), para provar o executor sem banco. */
const falsa = (ajuste = () => ({})) => config().etapas.map((e) => ({ ...e, exigidos: undefined, comandos: [[process.execPath, '-e', '0']], ...ajuste(e) }));
const porNome = (rel) => Object.fromEntries(rel.etapas.map((e) => [e.nome, e.status]));

test('Guia M3 §16: as 17 etapas com os nomes literais do livro, na ordem, no etapas.js, no etapas.json, no script e no workflow', () => {
  if (fs.existsSync(CADERNO)) {
    const linhas = fs.readFileSync(CADERNO, 'utf8').split('\n');
    const i = linhas.findIndex((l) => /^16\. CI\/CD/.test(l.trim()));
    assert.ok(i > 0, 'o caderno tem a seção "16. CI/CD"');
    assert.deepEqual(linhas.slice(i + 1, i + 1 + LIVRO.length).map((l) => l.trim()), LIVRO, 'a lista do teste é a do livro');
  }
  assert.deepEqual([...E.NOMES_DO_LIVRO], LIVRO);
  assert.deepEqual(config().etapas.map((e) => [e.numero, e.nome]), LIVRO.map((n, i) => [i + 1, n]));
  assert.deepEqual(E.problemasDaDefinicao(config().etapas), []);
  for (const f of ['scripts/ci-estagios-marco3.sh', '.github/workflows/marco3-esteira.yml']) {
    const texto = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(emOrdem(texto, LIVRO), `${f} cita as 17 etapas na ordem do livro`);
  }
});

test('Guia M3 §16: reordenar, renomear, faltar etapa, trocar o tipo ou tentar deploy de produção é recusado', () => {
  const ok = config().etapas;
  assert.throws(() => E.carregar(path.join(os.tmpdir(), 'nao-existe.json')));
  const casos = [
    [[...ok].reverse(), /posição 1/],
    [ok.map((e) => (e.nome === 'merge_tests' ? { ...e, nome: 'merge' } : e)), /esperado "merge_tests"/],
    [ok.filter((e) => e.nome !== 'load_tests'), /são 16 etapas/],
    [ok.map((e) => (e.nome === 'deploy_LAB' ? { ...e, tipo: 'push' } : e)), /deploy_LAB\) é "push"/],
    [ok.map((e) => (e.nome === 'production_approval' ? { ...e, comandos: [['node', 'scripts/deploy-production.js']] } : e)), /deploy de produção/],
  ];
  for (const [etapas, motivo] of casos) assert.match(E.problemasDaDefinicao(etapas).join('; '), motivo);
});

test('Guia M3 §16: toda etapa de teste aponta para pelo menos um arquivo real e os testes exigidos existem nos arquivos', () => {
  const etapasDeTeste = config().etapas.filter((e) => /_tests$/.test(e.nome) && e.nome !== 'load_tests');
  assert.equal(etapasDeTeste.length, 9);
  for (const e of [...etapasDeTeste, config().etapas.find((x) => x.nome === 'migrations')]) {
    const arquivos = E.arquivosDeTeste(e);
    assert.ok(arquivos.length > 0, `${e.nome} sem arquivo de teste`);
    for (const a of arquivos) assert.ok(fs.existsSync(path.join(ROOT, a)), `${e.nome}: ${a} não existe`);
    assert.deepEqual(E.testesExigidosAusentes(e), [], `${e.nome}: teste exigido sumiu`);
    assert.ok(E.comandosDaEtapa(e).some((c) => c[1] === '--test'), `${e.nome} roda node --test`);
  }
  for (const e of config().etapas) {
    for (const c of e.comandos.filter(Array.isArray)) {
      for (const s of c.filter((x) => /^(scripts|test)\/.+\.(js|sh)$/.test(x))) assert.ok(fs.existsSync(path.join(ROOT, s)), `${e.nome}: ${s} não existe`);
    }
  }
  assert.ok(config().etapas.find((e) => e.nome === 'ai_grounding_tests').comandos[0].testes.includes('test/marco9/ia/m9d034.*.test.js'));
});

test('Guia M3 §16: fora da tag, deploy_DEV, deploy_LAB e production_approval saem NAO_APLICAVEL no relatório; com --release rodam', () => {
  const sem = executar(falsa(), [], { DISPOSABLE_DB: '1' });
  assert.equal(sem.status, 0, sem.saida);
  assert.equal(sem.rel.etapas.length, 17);
  const s = porNome(sem.rel);
  for (const n of ['deploy_DEV', 'deploy_LAB', 'production_approval']) assert.equal(s[n], 'NAO_APLICAVEL');
  for (const n of LIVRO.filter((x) => !['deploy_DEV', 'deploy_LAB', 'production_approval'].includes(x))) assert.equal(s[n], 'VERDE', n);
  assert.match(sem.rel.etapas.find((e) => e.nome === 'deploy_DEV').motivo, /m3-release-/);
  assert.ok(sem.rel.etapas.every((e) => e.commit && typeof e.duracaoMs === 'number'));

  const com = executar(falsa(), ['--release', '--de', '14', '--ate', '17'], { DISPOSABLE_DB: '1' });
  assert.deepEqual(porNome(com.rel), { deploy_DEV: 'VERDE', deploy_LAB: 'VERDE', load_tests: 'VERDE', production_approval: 'AGUARDANDO_APROVACAO' });
  const noGithub = executar(falsa(), ['--release', '--de', '17', '--ate', '17'], { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '42' });
  assert.equal(porNome(noGithub.rel).production_approval, 'VERDE');
});

test('Guia M3 §16: a primeira etapa vermelha para a esteira (as seguintes NAO_RODOU, M3_CI_STAGE_FAILED) e nada depois dela roda', () => {
  const marca = path.join(os.tmpdir(), `m3ci-depois-${process.pid}`);
  fs.rmSync(marca, { force: true });
  const etapas = falsa((e) => (e.nome === 'merge_tests' ? { comandos: [[process.execPath, '-e', 'process.exit(3)']] }
    : e.nome === 'property_offer_tests' ? { comandos: [[process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marca)}, 'x')`]] } : {}));
  const r = executar(etapas, [], { DISPOSABLE_DB: '1' });
  assert.equal(r.status, 1);
  assert.match(r.saida, /M3_CI_STAGE_FAILED/);
  const s = porNome(r.rel);
  assert.equal(s.people_dedup_tests, 'VERDE');
  assert.equal(s.merge_tests, 'VERMELHO');
  for (const n of LIVRO.slice(LIVRO.indexOf('property_offer_tests'))) assert.equal(s[n], 'NAO_RODOU', n);
  assert.equal(fs.existsSync(marca), false, 'a etapa seguinte à vermelha não rodou');
});

test('Guia M3 §16: etapa de banco fora do banco descartável é vermelha; arquivo de teste ou teste exigido ausente recusa a esteira antes de rodar', () => {
  const fora = executar(falsa(), ['--ate', '3']);
  assert.equal(fora.status, 1);
  assert.equal(porNome(fora.rel).migrations, 'VERMELHO');
  assert.match(fora.rel.etapas.find((e) => e.nome === 'migrations').motivo, /banco descartável/);

  const semArquivo = executar(falsa((e) => (e.nome === 'consent_tests' ? { comandos: [{ testes: ['test/naoExiste.m3.test.js'] }] } : {})), [], { DISPOSABLE_DB: '1' });
  assert.equal(semArquivo.status, 1);
  assert.match(semArquivo.rel.recusada, /M3_CI_STAGES_MISMATCH: etapa 10 \(consent_tests\): nenhum arquivo de teste/);
  assert.equal(semArquivo.rel.etapas.length, 0, 'nenhuma etapa rodou');

  const semExigido = executar(falsa((e) => (e.nome === 'radar_idempotency_tests'
    ? { comandos: [{ testes: ['test/radar.idempotency.test.js'] }], exigidos: ['teste que alguém apagou'] } : {})), [], { DISPOSABLE_DB: '1' });
  assert.match(semExigido.rel.recusada, /testes exigidos ausentes: teste que alguém apagou/);
  assert.equal(semExigido.rel.etapas.length, 0);
});

test('Guia M3 §16: o workflow roda a esteira em banco descartável; release só em tag; production_approval atrás do environment com revisor, sem deploy', () => {
  const texto = fs.readFileSync(WORKFLOW, 'utf8');
  assert.doesNotMatch(texto, /continue-on-error/);
  assert.doesNotMatch(texto, /if:\s*false/);
  const w = yaml.load(texto);
  const passo = (job, re) => (w.jobs[job].steps || []).find((s) => re.test(s.run || ''));
  assert.match(passo('esteira-marco3', /ci-estagios-marco3\.sh/).run, /--ate 17/);
  assert.equal(w.jobs['esteira-marco3'].if, undefined, 'as etapas de código e banco rodam em todo push e pull request');
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts', 'ci-estagios-marco3.sh'), 'utf8'), /withDisposableDb\.js/);
  assert.match(w.jobs['release-marco3'].if, /refs\/tags\/m3-release-/);
  assert.match(passo('release-marco3', /executar\.js/).run, /--release --de 14 --ate 15/);
  assert.deepEqual(w.on.push.tags, ['m3-release-*']);
  assert.equal(w.jobs['aprovacao-marco3'].environment, 'marco3-aprovacao');
  assert.match(passo('aprovacao-marco3', /executar\.js/).run, /--release --de 17 --ate 17/);
  assert.doesNotMatch(JSON.stringify(w.jobs['aprovacao-marco3']), /curl|DEPLOY_HOOK/);
  assert.deepEqual(problemasDoPortao(w), []);
  const semRevisor = yaml.load(texto);
  delete semRevisor.jobs['aprovacao-marco3'].environment;
  semRevisor.jobs['release-marco3'].steps.push({ name: 'publicar', run: 'curl -X POST $PRODUCTION_API_DEPLOY_HOOK' });
  const p = problemasDoPortao(semRevisor).join('; ');
  assert.match(p, /environment: marco3-aprovacao/);
  assert.match(p, /deploy de produção/);
});

test('Guia M3 §16 load_tests: as invariantes da carga acusam violação de verdade, e a carga recusa volume inválido e banco que não é descartável', () => {
  assert.throws(() => exigirBancoDescartavel({}), /banco descartável/);
  assert.doesNotThrow(() => exigirBancoDescartavel({ DISPOSABLE_DB: '1' }));
  assert.throws(() => validarVolume({ ...config().carga, oportunidades: 0 }), /oportunidades/);
  assert.deepEqual(validarVolume(config().carga), config().carga);

  assert.deepEqual(inv.pessoaUnica({ tentativas: 8, aceitas: 1, recusas: { PERSON_DUPLICATE_TAX_ID: 5, PERSON_DUPLICATE: 2 } }, 1), []);
  assert.equal(inv.pessoaUnica({ tentativas: 8, aceitas: 2, recusas: { PERSON_DUPLICATE_TAX_ID: 6 } }, 2).length, 2);
  assert.match(inv.pessoaUnica({ tentativas: 2, aceitas: 1, recusas: { SequelizeDatabaseError: 1 } }, 1)[0], /código inesperado/);

  const volume = config().carga;
  const opOk = { erros: [], semProximaAcao: { aceitas: 0, recusas: { OPPORTUNITY_NEXT_ACTION_REQUIRED: 10 } } };
  assert.deepEqual(inv.proximaAcao(opOk, { oportunidadesDaRodada: volume.oportunidades, oportunidadesAtivasSemProximaAcao: 0 }, volume), []);
  assert.equal(inv.proximaAcao({ ...opOk, semProximaAcao: { aceitas: 1, recusas: {} } }, { oportunidadesDaRodada: volume.oportunidades, oportunidadesAtivasSemProximaAcao: 1 }, volume).length, 2);

  const eventos = Array.from({ length: volume.imoveisComOferta }, (_, i) => ({ property_id: `p${i}`, n: 1 }));
  const radarOk = { errosNasOfertas: [], radares: [{ tipo: 'job', radarId: 'r1', reprocessamentos: { finalComErro: [] } }] };
  const umRadar = (extra = {}) => ({ radares: [{ radarId: 'r1', matchesRepetidos: [], imoveisComMatch: volume.imoveisComOferta, eventosMatchCreated: volume.imoveisComOferta,
    eventosRadarMatchedPorImovel: eventos, notificacoes: 1, imoveisAnunciados: volume.imoveisComOferta, ...extra }] });
  assert.deepEqual(inv.radarIdempotente(radarOk, umRadar(), volume), []);
  const v = inv.radarIdempotente(radarOk, umRadar({ matchesRepetidos: [{ property_id: 'p0', criteria_fingerprint: 'f', n: 2 }], notificacoes: 2, imoveisAnunciados: volume.imoveisComOferta * 2 }), volume).join('; ');
  assert.match(v, /radar_match repetido/);
  assert.match(v, /aviso repetido/);
  assert.match(inv.radarIdempotente(radarOk, umRadar({ eventosRadarMatchedPorImovel: [{ property_id: 'p0', n: 2 }] }), volume).join('; '), /radar.matched repetido/);

  assert.deepEqual(inv.isolamento({ pessoas: 0, oportunidades: 0 }), []);
  assert.match(inv.isolamento({ pessoas: 0, oportunidades: 2 })[0], /enxerga 2 oportunidades/);
  assert.equal(inv.percentil([5, 1, 3, 2, 4], 95), 5);
  assert.equal(inv.latencia({ q: { n: 3, linhas: 1, tempos: [10, 20, 9000] } }, 3000).violacoes.length, 1);
});
