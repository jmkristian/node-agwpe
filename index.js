'use strict';
const server = require('./server.js');

/** API for accessing an AGWPE-compatible TNC, in the style of node net. */

exports.Reader = server.Reader;
exports.Writer = server.Writer;
exports.Server = server.Server;
exports.toDataSummary = server.toDataSummary;
