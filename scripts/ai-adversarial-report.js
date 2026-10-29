'use strict';

/**
 * Roda a suíte adversarial da NAY (M9-D042) e grava o relatório `adversarial-report.json` (por teste: passou, duração, evidência).
 * Sai com código diferente de 0 se algum teste reprovar, faltar ou estiver pulado: é o que bloqueia o merge no CI (D044, estágio 7).
 * Precisa do banco descartável: `npm run test:ai:adversarial`. Variáveis: ADVERSARIAL_REPORT (caminho do relatório).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateManifest, validateReport } = require('./ai-adversarial/gate');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'test', 'marco9', 'ia', 'adversarial');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'adversarial.manifest.json'), 'utf8'));
const destino = process.env.ADVERSARIAL_REPORT || path.join(ROOT, 'docs', 'evidencias', 'ci', manifest.relatorio);

function commit() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function main() {
  const antes = validateManifest(manifest, (f) => (fs.existsSync(path.join(DIR, f)) ? fs.readFileSync(path.join(DIR, f), 'utf8') : null));
  if (antes.length) { process.stderr.write(`Manifesto inválido:\n- ${antes.join('\n- ')}\n`); return 1; }
  const eventos = path.join(os.tmpdir(), `ai-adversarial-${process.pid}.jsonl`);
  const arquivos = fs.readdirSync(DIR).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(DIR, f));
  const run = spawnSync(process.execPath, [
    '--test', '--test-concurrency=1', '--test-reporter=spec', '--test-reporter-destination=stdout',
    `--test-reporter=${path.join(__dirname, 'ai-adversarial', 'reporter.js')}`, `--test-reporter-destination=${eventos}`, ...arquivos,
  ], { cwd: ROOT, stdio: 'inherit', env: process.env });
  const linhas = fs.existsSync(eventos) ? fs.readFileSync(eventos, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  fs.rmSync(eventos, { force: true });
  const testes = manifest.testes.map((t) => {
    const l = linhas.find((x) => x.nome === t.nome);
    return {
      ordem: t.ordem, nome: t.nome, demandaDona: t.demandaDona, categoria: t.categoria, passou: Boolean(l && l.passou), pulado: Boolean(l && l.pulado), duracaoMs: l ? l.duracaoMs : null,
      evidencia: l && l.passou ? `aprovado no provider sandbox: ${t.resultadoExigido}` : `não aprovado: ${(l && l.erro) || 'teste não executado'}`,
    };
  });
  const relatorio = {
    suite: 'adversarial-nay', demanda: 'M9-D042', commit: commit(), geradoEm: new Date().toISOString(), node: process.version, provider: 'ai-sandbox',
    totais: { esperados: manifest.testes.length, aprovados: testes.filter((t) => t.passou).length, reprovados: testes.filter((t) => !t.passou).length },
    testes, outros: linhas.filter((l) => !manifest.testes.some((t) => t.nome === l.nome)).map((l) => ({ nome: l.nome, passou: l.passou, duracaoMs: l.duracaoMs })),
  };
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, `${JSON.stringify(relatorio, null, 2)}\n`);
  const problemas = validateReport(relatorio, manifest);
  const reprovadoFora = relatorio.outros.filter((o) => !o.passou).map((o) => `${o.nome}: reprovado`);
  const todos = [...problemas, ...reprovadoFora, ...(run.status === 0 ? [] : [`o runner terminou com código ${run.status}`])];
  process.stdout.write(`\nadversarial-report.json: ${relatorio.totais.aprovados}/${relatorio.totais.esperados} aprovados (${destino})\n`);
  if (todos.length) { process.stderr.write(`Suíte adversarial reprovada:\n- ${todos.join('\n- ')}\n`); return 1; }
  return 0;
}

process.exit(main());
