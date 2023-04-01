'use strict';
const client = require('./client.js');
const server = require('./server.js');

/** Communicate via AX.25 in the style of node net, using an AGWPE-compatible TNC. */

exports.createConnection = client.createConnection;
exports.Server = server.Server;
