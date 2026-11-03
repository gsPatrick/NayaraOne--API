'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { contar, detalharPulados, casosDoXml } = require('../checkJunit');
const { LeituraError } = require('./erros');
const { RAIZ_API } = require('./config');
const { expandirGlobs } = require('./globs');

const LIMITE_SAIDA = 256 * 1024 * 1024;

/** Roda um comando e devolve { status, out }. `status` nulo (morto por sinal ou não iniciou) é erro de leitura: nunca vira "ok". */
function rodar(comando, args, { cwd = RAIZ_API, env = process.env } = {}) {
  const r = spawnSync(comando, args, { cwd, env, encoding: 'utf8', maxBuffer: LIMITE_SAIDA });
  if (r.error || r.status === null) throw new LeituraError(`não foi possível executar ${path.basename(args[0] || comando)}: ${(r.error && r.error.code) || r.signal || 'sem código de saída'}`);
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '' };
}

/**
 * Roda uma suíte `node --test` (padrões de arquivo expandidos pelo próprio Node, um processo, sem concorrência) com relatório JUnit e confere o relatório: ao menos um teste e
 * NENHUM pulado (no banco descartável teste pulado reprova). Devolve { ok, motivo }.
 */
function rodarSuite(globs, { env = process.env } = {}) {
  const { NODE_TEST_CONTEXT: _herdado, ...limpo } = env; // dentro de outro `node --test` o filho trataria a suíte como subteste
  if (!Array.isArray(globs) || !globs.length) throw new LeituraError('suíte sem arquivos de teste na configuração');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dod-f-'));
  const junit = path.join(dir, 'suite.junit.xml');
  try {
    const r = rodar(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=junit', `--test-reporter-destination=${junit}`, ...expandirGlobs(globs).map((a) => path.resolve(RAIZ_API, a))], { env: { ...limpo, NODE_ENV: 'test' } });
    let xml;
    try { xml = fs.readFileSync(junit, 'utf8'); } catch (e) { throw new LeituraError(`relatório JUnit da suíte não foi gerado: ${e.code || e.message}`); }
    const c = contar(xml);
    if (!c.testes) return { ok: false, motivo: 'a suíte não executou nenhum teste' };
    // Única exceção, a mesma do checkJunit: com CI_SEM_REPOS_IRMAOS=1, o teste pulado com a mensagem NAO_APLICAVEL_NO_CI (artefato irmão ausente) não reprova, mas é contado à parte.
    const naoAplicaveis = env.CI_SEM_REPOS_IRMAOS === '1' ? detalharPulados(casosDoXml(xml)).filter((d) => /^NAO_APLICAVEL_NO_CI\b/.test(d.mensagem)) : [];
    const pulados = c.pulados.filter((n) => !naoAplicaveis.some((d) => d.nome === n));
    if (pulados.length) return { ok: false, motivo: `${pulados.length} teste(s) pulado(s) no banco descartável (${pulados.slice(0, 3).join('; ')})` };
    if (r.status !== 0) return { ok: false, motivo: `a suíte falhou (${c.testes} testes; ${(r.out.match(/^# fail (\d+)/m) || [])[1] || '?'} com falha)` };
    if (naoAplicaveis.length) return { ok: true, naoAplicavel: naoAplicaveis.length, motivo: `${c.testes} testes, ${c.testes - naoAplicaveis.length} executados, ${naoAplicaveis.length} NAO_APLICAVEL_NO_CI (artefato irmão ausente, coberto na suíte local: ${naoAplicaveis.map((d) => d.nome).slice(0, 3).join('; ')}), nenhum outro pulado` };
    return { ok: true, motivo: `${c.testes} testes, nenhum pulado` };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = { rodar, rodarSuite };
