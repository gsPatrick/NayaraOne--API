'use strict';

const fs = require('node:fs');
const { daRaiz } = require('./config');
const { LeituraError } = require('./erros');
const { rodar } = require('./processo');

const NOME = 'manifest documental';

/** Item 5: chama verificar-manifest.js (M9-D932) sobre o manifest dos documentos CURRENT. Exit 0 = ok; 1 = violação GOV_MANIFEST_*; 2 = índice inválido (erro de leitura). */
async function verificar({ cfg }) {
  const m = cfg.manifest;
  // CI só com a API (CI_SEM_REPOS_IRMAOS=1): sem a pasta Maturacao o item sai NAO_APLICAVEL_NO_CI, visível e contado à parte; nunca "OK". Sem a declaração, a ausência segue sendo erro de leitura.
  if (process.env.CI_SEM_REPOS_IRMAOS === '1' && !fs.existsSync(daRaiz(m.script))) return { nome: NOME, ok: true, situacao: 'NAO_APLICAVEL_NO_CI', motivo: `NAO_APLICAVEL_NO_CI: ${m.script} ausente neste CI (CI_SEM_REPOS_IRMAOS=1); o manifest NAO foi conferido aqui, coberto na suíte local` };
  const r = rodar(process.execPath, [daRaiz(m.script), daRaiz(m.manifest), ...(m.args || []).map((a) => (a.startsWith('--') ? a : daRaiz(a)))]);
  if (r.status === 2) throw new LeituraError('o índice documental é inválido (verificar-manifest.js saiu com 2)');
  if (r.status !== 0) {
    const erros = r.out.split('\n').filter((l) => l.startsWith('ERRO ')).map((l) => l.replace(/^ERRO /, ''));
    return { nome: NOME, ok: false, motivo: `verificar-manifest.js reprovou: ${(erros.slice(0, 2).join(' | ') || `exit ${r.status}`)}${erros.length > 2 ? ` (+${erros.length - 2})` : ''}` };
  }
  return { nome: NOME, ok: true, motivo: 'verificar-manifest.js saiu com 0 sobre o manifest dos documentos CURRENT' };
}

module.exports = { verificar, NOME };
