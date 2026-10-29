'use strict';

const { definePort } = require('../ports/definePort');

/** Port SocialAdapter (domínio SOCIAL, M9-D209): operações, entradas e saída normalizada versionadas. */
const SocialAdapter = definePort('SocialAdapter', 'SOCIAL', {
  publishPost: ['text'],
  getPostStatus: ['externalResourceId'],
  deletePost: ['externalResourceId'],
  findPostByKey: ['idempotencyKey'],
});

module.exports = { SocialAdapter };
