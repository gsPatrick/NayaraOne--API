'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { majorOf } = require('./openapi.load');

/**
 * Regras de versão (M9-D840 §3.3). Major igual: compara. Major maior: não compara; exige que o arquivo da major anterior (`openapi.v<MAJOR-1>.yaml`, na mesma pasta do candidato)
 * continue no repositório com `info.x-deprecated: true` e `info.x-sunset`. Major menor: regressão. Devolve { mode: 'compare'|'new-major'|'regression', problems: [{rule, where, detail}] }.
 */
function planVersion(baseDoc, candDoc, candidatePath, parse) {
  const baseMajor = majorOf(baseDoc);
  const candMajor = majorOf(candDoc);
  if (candMajor === baseMajor) return { mode: 'compare', baseMajor, candMajor, problems: [] };
  if (candMajor < baseMajor) return { mode: 'regression', baseMajor, candMajor, problems: [{ rule: 'VERSION_DECREASED', where: 'info.version', detail: `major ${baseMajor} -> ${candMajor}` }] };
  const previous = path.join(path.dirname(candidatePath), `openapi.v${baseMajor}.yaml`);
  const problems = [];
  if (!fs.existsSync(previous)) problems.push({ rule: 'MAJOR_PREVIOUS_MISSING', where: previous, detail: `a major ${baseMajor} deixou de ser servida (arquivo ausente)` });
  else {
    const doc = parse(fs.readFileSync(previous, 'utf8'), `openapi.v${baseMajor}.yaml`);
    if (doc.info['x-deprecated'] !== true) problems.push({ rule: 'MAJOR_PREVIOUS_NOT_DEPRECATED', where: previous, detail: 'falta info.x-deprecated: true' });
    if (typeof doc.info['x-sunset'] !== 'string' || Number.isNaN(Date.parse(doc.info['x-sunset']))) problems.push({ rule: 'MAJOR_PREVIOUS_NOT_DEPRECATED', where: previous, detail: 'falta info.x-sunset com uma data' });
  }
  return { mode: 'new-major', baseMajor, candMajor, problems };
}

module.exports = { planVersion };
