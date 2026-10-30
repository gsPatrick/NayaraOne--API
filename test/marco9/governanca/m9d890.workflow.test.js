'use strict';

// M9-D890: o workflow de CI da governança tem as 8 verificações do Guia §8, o nono job (regressão AUD) e nenhum continue-on-error.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const RAIZ = path.join(__dirname, '..', '..', '..');
const WORKFLOW = yaml.load(fs.readFileSync(path.join(RAIZ, '.github', 'workflows', 'governanca.yml'), 'utf8'));
const SCRIPT = fs.readFileSync(path.join(RAIZ, 'scripts', 'ci-governanca.sh'), 'utf8');
const TESTES = fs.readdirSync(path.join(RAIZ, 'test', 'marco9', 'governanca'));

const comandoDe = (job) => (WORKFLOW.jobs[job].steps.find((s) => /ci-governanca\.sh/.test(s.run || '')) || {}).run;
const trechoDe = (controle) => (SCRIPT.match(new RegExp(`^\\s*${controle}\\)([\\s\\S]*?)(?=^\\s*[a-z]+\\)|^esac)`, 'm')) || [])[1] || '';
// arquivos que o glob do controle alcança (bash [..] = um caractere)
const arquivosDoGlob = (glob) => {
  const re = new RegExp(`^${glob.replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`);
  return TESTES.filter((f) => re.test(f));
};
const globsDe = (controle) => [...trechoDe(controle).matchAll(/test\/marco9\/governanca\/(\S+\.test\.js)/g)].map((m) => m[1]);

const OITO = {
  'calendar-idempotency': 'calendar', 'lineage-coverage': 'lineage', dlp: 'dlp', 'bcp-replay': 'bcp',
  'openapi-breaking': 'openapi', 'feature-expiry': 'flags', 'finops-thresholds': 'finops', accessibility: 'accessibility',
};

test('m9d890 workflow tem as 8 etapas do Guia', () => {
  for (const [job, controle] of Object.entries(OITO)) {
    assert.ok(WORKFLOW.jobs[job], `falta o job ${job}`);
    assert.equal(comandoDe(job).trim(), `bash scripts/ci-governanca.sh ${controle}`);
  }
  assert.match(trechoDe('lineage'), /npm run check:lineage/);
  assert.match(trechoDe('openapi'), /npm run lint:openapi/);
  assert.match(trechoDe('openapi'), /npm run test:contract/);
  assert.match(trechoDe('flags'), /npm run check:flags/);
  assert.match(trechoDe('accessibility'), /npm run test:a11y/);
  for (const c of ['calendar', 'dlp', 'bcp']) assert.ok(globsDe(c).length, `o controle ${c} roda testes de governança`);
  // cada controle com testes alcança arquivos que existem
  for (const c of ['calendar', 'dlp', 'bcp', 'finops']) for (const g of globsDe(c)) assert.ok(arquivosDoGlob(g).length > 0, `${c}: ${g} não alcança arquivo`);
  const gatilhos = WORKFLOW.on || WORKFLOW[true];
  assert.ok('push' in gatilhos && 'pull_request' in gatilhos, 'roda em push e em pull request');
  for (const job of Object.values(WORKFLOW.jobs)) {
    assert.notEqual(job['continue-on-error'], true);
    for (const s of job.steps) assert.notEqual(s['continue-on-error'], true);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(RAIZ, '.github', 'workflows', 'governanca.yml'), 'utf8'), /continue-on-error/);
  assert.ok(WORKFLOW.jobs['adversarial-map'] && /ci-governanca\.sh adversarial/.test(comandoDe('adversarial-map')), 'o mapa dos 10 adversariais roda no CI');
});

test('m9d890 workflow tem o job de regressão AUD além das 8 etapas do Guia', () => {
  assert.ok(WORKFLOW.jobs['aud-regression']);
  assert.equal(comandoDe('aud-regression').trim(), 'bash scripts/ci-governanca.sh aud');
  assert.ok(!Object.values(OITO).includes('aud'), 'o nono job não é um dos controles do Guia §8');
  assert.match(trechoDe('aud'), /m9d809\.aud\*\.test\.js/);
  // os arquivos m9d809.aud* são entregues pela M9-D809 (a existência deles é provada nos testes dela)
  // as etapas com banco publicam o JUnit e o resumo como artefato
  assert.ok(WORKFLOW.jobs['aud-regression'].steps.some((s) => /upload-artifact/.test(s.uses || '') && /governanca/.test(s.with.path)));
});

test('m9d890 job finops cobre D861, D862 e D863', () => {
  const globs = globsDe('finops');
  assert.equal(globs.length, 1);
  const alcancados = TESTES.filter((f) => /^m9d86[123]\..*\.test\.js$/.test(f));
  for (const d of ['m9d861', 'm9d862', 'm9d863']) assert.ok(alcancados.some((f) => f.startsWith(`${d}.`)), `${d} tem teste alcançado pelo job finops`);
  assert.match(globs[0], /m9d86\[123\]/);
  assert.match(trechoDe('finops'), /testes_com_banco finops/);
});

test('m9d890 a etapa com banco usa o cluster descartável e confere o JUnit', () => {
  assert.match(SCRIPT, /scripts\/withDisposableDb\.js --port/);
  assert.match(SCRIPT, /checkJunit\.js/);
  assert.doesNotMatch(SCRIPT, /continue-on-error|\|\| true/);
  assert.doesNotMatch(SCRIPT, /\.env/);
});
