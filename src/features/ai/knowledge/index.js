'use strict';

const registry = require('./knowledgeRegistry.service');
const lifecycle = require('./knowledgeLifecycle.service');
const expiry = require('./knowledgeExpiry.service');

/** Conhecimento homologado e versionado da empresa (M9-D008): ai.knowledge_entries. O uso pelo RAG é de M9-D023 e M9-D024. */
module.exports = {
  createEntry: registry.createEntry,
  updateDraft: registry.updateDraft,
  getEntry: registry.getEntry,
  listEntries: registry.listEntries,
  homologate: lifecycle.homologate,
  revoke: lifecycle.revoke,
  expireEnded: expiry.expireEnded,
};
