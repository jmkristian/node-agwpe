'use strict';
const server = require('./server.js');

/** Communicate via AX.25 in the style of node net, using an AGWPE-compatible TNC. */

exports.Reader = server.Reader;
exports.Writer = server.Writer;
exports.Server = server.Server;
exports.toDataSummary = server.toDataSummary;
