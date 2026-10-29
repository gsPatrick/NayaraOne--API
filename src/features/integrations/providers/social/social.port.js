'use strict';

const { definePort } = require('../ports/definePort');
const { social } = require('../../minimization/mappers');

/** Port SocialAdapter (domínio SOCIAL, M9-D209): operações, entradas e saída normalizada versionadas. */
const SocialAdapter = definePort('SocialAdapter', 'SOCIAL', {
  publishPost: { required: ['text'], outputMapper: social.publishPost },
  getPostStatus: ['externalResourceId'],
  deletePost: ['externalResourceId'],
  findPostByKey: ['idempotencyKey'],
});

module.exports = { SocialAdapter };
