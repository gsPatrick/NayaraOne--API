'use strict';

const { MemoryService } = require('./MemoryService');
const settings = require('./memory.settings');
const constants = require('./memory.constants');
const { readMemoryParams } = require('./memory.params');
const { MEMORY_CONTEXT_FIELDS } = require('./memory.context');

/** Memória empresarial estruturada da NAY (M9-D009). */
module.exports = { MemoryService, readMemoryParams, ...settings, constants, MEMORY_CONTEXT_FIELDS };
