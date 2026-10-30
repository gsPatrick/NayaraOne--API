'use strict';

const { KEY_RE } = require('../../flags.constants');

/**
 * Registro dos probes de kill switch (M9-D872 §3.1). Probe = verificação automatizada que prova que a função parou quando o switch está acionado. Cada demanda dona de um kill switch
 * (Marketing em M9-D425, canais, integrações) registra o seu probe com `registerProbe({ name, version, description, run })`; esta demanda não define a lista de switches.
 *   run({ tenant, flag, environment, transaction, now }) => { pass: boolean, evidence?: object }   (lançar erro conta como FAIL)
 * `version` muda quando o código do probe muda: o PASS vale só para a versão atual (o mesmo código roda em todos os ambientes).
 */
const probes = new Map();

function registerProbe(probe) {
  const p = probe || {};
  if (typeof p.name !== 'string' || !KEY_RE.test(p.name)) throw new Error('Probe de kill switch: o nome deve ter o formato dominio.recurso.nome, em minúsculas.');
  if (typeof p.version !== 'string' || !p.version.trim() || p.version.length > 32) throw new Error(`Probe ${p.name}: informe a versão (texto de até 32 caracteres).`);
  if (typeof p.run !== 'function') throw new Error(`Probe ${p.name}: informe a função run.`);
  const known = probes.get(p.name);
  if (known) {
    if (known.run === p.run || known.version !== p.version) { probes.set(p.name, Object.freeze({ ...p })); return known; }
    throw new Error(`Probe ${p.name}: já registrado na versão ${known.version} com outra função.`);
  }
  probes.set(p.name, Object.freeze({ ...p }));
  return p;
}

const getProbe = (name) => probes.get(name) || null;
const listProbes = () => [...probes.values()].map(({ name, version, description }) => ({ name, version, description: description || null }));

module.exports = { registerProbe, getProbe, listProbes };
