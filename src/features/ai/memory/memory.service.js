'use strict';

const { saveMemory } = require('./memory.save');
const { invalidateMemory, correctMemory } = require('./memory.change');
const { recallMemories, listMemories, getMemory } = require('./memory.recall');
const { proposeMemory } = require('./memory.propose');
const { expireMemories } = require('./memory.expire');
const { toContextSources } = require('./memory.context');

/** Fachada funcional da memória da NAY (M9-D009): gravar, lembrar, invalidar, corrigir, listar, propor e expirar. */
module.exports = { saveMemory, recallMemories, invalidateMemory, correctMemory, listMemories, getMemory, proposeMemory, expireMemories, toContextSources };
