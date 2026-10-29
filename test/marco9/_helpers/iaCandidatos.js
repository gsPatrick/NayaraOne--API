'use strict';

// Linhas do ranking de candidatos (M9-D011) sem banco: { providerCode, policy, model, capabilities }.
const { modelo } = require('./iaAdapterCtx');

const linha = (providerCode, modelOver = {}, policy = {}, capabilities = ['generate']) => ({
  providerCode, capabilities, policy: { labOnly: false, ...policy }, model: modelo({ model: `${providerCode}-m`, ...modelOver }),
});
const PARAMS = { production: false, criticalMinSafetyTier: 2 };
const nomes = (lista) => lista.map((c) => `${c.providerCode}/${c.model}`);

module.exports = { linha, PARAMS, nomes };
