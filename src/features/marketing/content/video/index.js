'use strict';

const media = require('./media.service');
const { assembleReel } = require('./video.assemble');
const { resolveMedia } = require('./video.resolve');
const { registerRenderer, clearRenderer } = require('./video.render');
const body = require('./video.body');
const { draftVideoCopy, videoTexts } = require('./video.copy');
const { VIDEO_SETTINGS_SCHEMA, VIDEO_SETTING_DEFAULTS, readVideoConfig } = require('./video.settings');
const { ALLOWED_OPERATIONS, validateOperations } = require('./video.operations');
const router = require('./media.routes');

/** Vídeo e mídia do Marketing (M9-D426): autorização, montagem com original preservado, operações permitidas, transparência do sintético e roteiro/legenda/descrição. */
module.exports = {
  router, authorizeMedia: media.authorizeMedia, revokeMedia: media.revokeMedia, assertAuthorized: media.assertAuthorized, assembleReel, resolveMedia, registerRenderer, clearRenderer,
  isVideo: body.isVideo, prepareVideoMedia: body.prepareVideoMedia, buildVideoBody: body.buildVideoBody, assertVideoDisclosure: body.assertVideoDisclosure, draftVideoCopy, videoTexts,
  VIDEO_SETTINGS_SCHEMA, VIDEO_SETTING_DEFAULTS, readVideoConfig, ALLOWED_OPERATIONS, validateOperations,
};
