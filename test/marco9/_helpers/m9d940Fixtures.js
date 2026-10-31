'use strict';

// Apoio dos testes M9-D940 (não é teste): monta, numa pasta temporária, o ambiente do fechamento do bloco F (configuração, relatório DRY3, suítes mínimas, manifest, mapa dos nove
// testes) e roda scripts/checkDodBlocoF.js como o CI. Registry e DLP usam o banco descartável do processo (DISPOSABLE_DB=1): rode com scripts/withDisposableDb.js.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RAIZ = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(RAIZ, 'scripts', 'checkDodBlocoF.js');
const MATURACAO = path.resolve(RAIZ, '..', 'Maturacao', 'indice-documental');
const CRITERIOS = ['blockers_zero', 'counts_match', 'batches_verified', 'parallel_clean', 'clock_tz_validated', 'rollback_simulated'];
const NOMES_DO_LIVRO = [
  'm9d900 CDC replay produz o mesmo estado e o mesmo hash', 'm9d901 Control Tower totals fecham com o total', 'm9d905 batch checksum idêntico gera raízes iguais',
  'm9d903 parallel compare detecta diferença de 1 centavo', 'm9d912 legal hold sempre prevalece sobre a retenção', 'm9d911 retention dry-run não altera nenhum dado',
  'm9d915 field masking em tela, API e exportação', 'm9d915 AI access classification retira campos com ai_allowed falso', 'm9d931 obsolete document excluded do Caderno Final',
];
const INDICE_CONFIG = { prefixo: 'NAY', digitos: 3, offset_data_simples: '-03:00', timezone: 'America/Sao_Paulo', rotulo_prevalente: 'BLINDADA', manifest: { arquivo: 'manifest.json', chunk_bytes: 4096 }, caderno_final: { arquivo: 'CADERNO_FINAL.md', exclusoes_json: 'EXCLUSOES.json' }, tipos: { CAD: 'caderno' } };

const escrever = (arquivo, conteudo) => fs.writeFileSync(arquivo, typeof conteudo === 'string' ? conteudo : `${JSON.stringify(conteudo, null, 2)}\n`);

/** Relatório DRY3 aprovado, no formato exportado pela M9-D908 (`mudancas` sobrescreve campos de primeiro nível; `criterios` os critérios). */
function relatorioDry3(mudancas = {}, criterios = {}) {
  const criteria = Object.fromEntries(CRITERIOS.map((c) => [c, { ok: true }]));
  criteria.batches_verified = { ok: true, total: 4, verified: 4, pct: 100 };
  return { conclusion: 'APROVADO', criteria: { ...criteria, ...criterios }, commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', generated_at: '2026-10-31T12:00:00.000Z', report_id: 'rel-m9d940', ...mudancas };
}

function suiteMinima(dir, nome, corpo = "test('passa', () => {});") {
  const arquivo = path.join(dir, nome);
  escrever(arquivo, `'use strict';\nconst { test } = require('node:test');\n${corpo}\n`);
  return arquivo;
}

function manifestDeFixture(dir) {
  const docs = [1, 2].map((n) => ({ document_code: `NAY-CAD-00${n}`, title: `Doc ${n}`, version: 'BLINDADA v1', status: 'CURRENT', supersedes: [], effective_at: '2026-10-20', owner: 'Patrick', path: `DOC_${n}.txt`, family: `FAM_${n}`, build_order: n, notes: '' }));
  for (const d of docs) escrever(path.join(dir, d.path), `CONTEUDO-${d.document_code}\n`);
  escrever(path.join(dir, 'indice.json'), { documentos: docs });
  escrever(path.join(dir, 'indice-config.json'), INDICE_CONFIG);
  escrever(path.join(dir, 'escopo.json'), { globs: ['MARCO_[0-9]*_CADERNO_COMPLETO.md'] });
  const base = ['--raiz', dir, '--indice', path.join(dir, 'indice.json'), '--config', path.join(dir, 'indice-config.json'), '--escopo', path.join(dir, 'escopo.json')];
  const r = spawnSync(process.execPath, [path.join(MATURACAO, 'gerar-manifest.js'), ...base, '--saida', path.join(dir, 'saida')], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`fixture do manifest: ${r.stdout}${r.stderr}`);
  return base;
}

function mapaDosNove(dir, { sem = null, comoSkip = null } = {}) {
  const fonte = NOMES_DO_LIVRO.filter((n) => n !== sem).map((n) => `test('${n}', ${n === comoSkip ? '{ skip: true }, ' : ''}() => {});`).join('\n');
  escrever(path.join(dir, 'livro.test.js'), `'use strict';\nconst { test } = require('node:test');\n${fonte}\n`);
  const itens = NOMES_DO_LIVRO.map((nome, i) => ({ n: i + 1, frase: nome, demanda: 'M9-D940', testes: [nome] }));
  escrever(path.join(dir, 'mapa-livro.json'), { itens_do_livro: 9, raizes: [dir], itens });
}

/** Ambiente completo e verde. Devolve { dir, cfgPath, cfg, saida } e grava a configuração em `cfgPath` (altere `cfg` e chame `salvar`). */
function ambiente({ lineage = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d940-'));
  escrever(path.join(dir, 'dry3-report.json'), relatorioDry3());
  const sReg = suiteMinima(dir, 'registry.suite.test.js');
  const sDlp = suiteMinima(dir, 'dlp.suite.test.js');
  const argsManifest = manifestDeFixture(dir);
  mapaDosNove(dir);
  const cfg = {
    saida: path.join(dir, 'dod-bloco-f.json'),
    dry3: { arquivo: path.join(dir, 'dry3-report.json') },
    registry: { suites: [sReg] },
    lineage: lineage ? { registro: path.join(RAIZ, 'docs/governance/lineage-registry.json'), mapa: path.join(RAIZ, 'docs/governance/migration-field-map.json') } : {},
    dlp: { suites: [sDlp] },
    manifest: { script: path.join(MATURACAO, 'verificar-manifest.js'), manifest: path.join(dir, 'saida', 'manifest.json'), args: argsManifest },
    adversarial: { mapa: path.join(dir, 'mapa-livro.json') },
  };
  const cfgPath = path.join(dir, 'dod-config.json');
  const salvar = () => escrever(cfgPath, cfg);
  salvar();
  return { dir, cfg, cfgPath, salvar, saida: cfg.saida };
}

/** Roda o comando de fechamento (sem herdar o contexto do `node --test` que roda os testes). */
function fechar(amb, extra = [], env = {}) {
  const { NODE_TEST_CONTEXT: _c, ...limpo } = process.env;
  const r = spawnSync(process.execPath, [SCRIPT, '--config', amb.cfgPath, ...extra], { cwd: RAIZ, env: { ...limpo, ...env }, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, stderr: r.stderr };
}

const linha = (r, nome) => r.stdout.split('\n').find((l) => l.includes(nome)) || '';

module.exports = { RAIZ, SCRIPT, ambiente, fechar, relatorioDry3, suiteMinima, mapaDosNove, escrever, linha, NOMES_DO_LIVRO, CRITERIOS };
