'use strict';
const client = require('./client.js');
const guts = require('./guts.js');
const raw = require('./raw.js');
const server = require('./server.js');

/** Communicate via AX.25 in the style of node net, using an AGWPE-compatible TNC. */

exports.createConnection = client.createConnection;
exports.newError = guts.newError;
exports.newRangeError = guts.newRangeError;
exports.newTypeError = guts.newTypeError;
exports.Server = server.Server;
exports.validateCallSign = guts.validateCallSign;
exports.validatePath = guts.validatePath;
exports.validatePort = guts.validatePort;
