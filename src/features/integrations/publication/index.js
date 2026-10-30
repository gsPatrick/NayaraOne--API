'use strict';

/** Publicação do site e dos portais a partir do read model público (Marco 9, M9-D231). */
const { createPropertyPublicationDispatch, assertPropertyPublishable, loadPublicationReadModel, OPERATIONS } = require('./publication.dispatch');

module.exports = { createPropertyPublicationDispatch, assertPropertyPublishable, loadPublicationReadModel, OPERATIONS };
