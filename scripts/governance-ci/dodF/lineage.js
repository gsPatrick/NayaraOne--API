'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { LeituraError } = require('./erros');
const { daRaiz, RAIZ_API } = require('./config');
const { rodar } = require('./processo');

const NOME = 'lineage crítico';
const AREA_MIGRACAO = 'MIGRATION';

/** Item 3: `npm run check:lineage` (checkLineageCoverage.js) com cobertura crítica 100% e a área MIGRATION presente no registro (mapa e registro sem divergência é do próprio portão). */
async function verificar({ cfg }) {
  const args = [path.join(RAIZ_API, 'scripts', 'checkLineageCoverage.js'), '--json'];
  if (cfg.lineage.registro) args.push('--registry', daRaiz(cfg.lineage.registro));
  if (cfg.lineage.mapa) args.push('--map', daRaiz(cfg.lineage.mapa));
  const r = rodar(process.execPath, args);
  if (r.status === 2) throw new LeituraError(`o portão de lineage não leu os arquivos: ${r.out.trim().slice(0, 160)}`);
  let saida = null;
  try { saida = JSON.parse(r.stdout.trim().split('\n').pop()); } catch (_e) { /* o motivo vem do código de saída */ }
  if (r.status !== 0 || !saida || saida.ok !== true) {
    const detalhe = saida && saida.errors && saida.errors.length ? saida.errors.map((e) => e.code).join(', ') : `exit ${r.status}`;
    return { nome: NOME, ok: false, motivo: `o portão de lineage reprovou (${detalhe})` };
  }
  if (!(saida.critical > 0 && saida.covered === saida.critical)) return { nome: NOME, ok: false, motivo: `cobertura crítica ${saida.covered}/${saida.critical}` };
  let registro;
  try { registro = JSON.parse(fs.readFileSync(daRaiz(cfg.lineage.registro || 'docs/governance/lineage-registry.json'), 'utf8')); } catch (e) { throw new LeituraError(`não foi possível ler o registro de lineage: ${e.code || e.message}`); }
  const migracao = (registro.nodes || []).filter((n) => n.area === AREA_MIGRACAO).length;
  if (!migracao) return { nome: NOME, ok: false, motivo: `o registro não tem nenhum nó da área ${AREA_MIGRACAO}` };
  return { nome: NOME, ok: true, motivo: `cobertura crítica ${saida.covered}/${saida.critical}, ${migracao} nós da área ${AREA_MIGRACAO}, sem divergência entre mapa e registro` };
}

module.exports = { verificar, NOME };
