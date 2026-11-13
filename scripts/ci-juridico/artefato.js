'use strict';
/**
 * Artefato de deploy das etapas deploy_DEV e deploy_LAB da esteira do jurídico (Guia M5 §17): o mesmo conteúdo que o build
 * de produção usa (Dockerfile: o repositório no commit + VERSION com o commit + node_modules instalados). Aqui:
 *   git archive <commit> (só o que está commitado: nada da árvore de trabalho, nenhum .env) num diretório temporário,
 *   VERSION com o commit completo (o /api/version da API publicada devolve este valor) e node_modules ligado ao do job.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function git(raiz, args, opts = {}) {
  const r = spawnSync('git', args, { cwd: raiz, encoding: opts.encoding === null ? null : 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} falhou: ${String(r.stderr || '').slice(0, 400)}`);
  return r.stdout;
}

/** Monta o artefato do commit. Devolve { dir, commit, remover() }. */
function montarArtefato(raiz, rotulo) {
  const commit = String(git(raiz, ['rev-parse', 'HEAD'])).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jur-ci-${rotulo.toLowerCase()}-`));
  const tar = path.join(dir, '..', `${path.basename(dir)}.tar`);
  git(raiz, ['archive', '--format=tar', '-o', tar, commit]);
  const x = spawnSync('tar', ['-xf', tar, '-C', dir], { encoding: 'utf8' });
  fs.rmSync(tar, { force: true });
  if (x.status !== 0) throw new Error(`tar -xf falhou: ${x.stderr}`);
  if (fs.existsSync(path.join(dir, '.env'))) throw new Error('o artefato não pode ter .env');
  fs.writeFileSync(path.join(dir, 'VERSION'), `${commit}\n`);
  fs.symlinkSync(fs.realpathSync(path.join(raiz, 'node_modules')), path.join(dir, 'node_modules'), 'dir');
  return { dir, commit, remover: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { montarArtefato };
