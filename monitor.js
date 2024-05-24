/** Monitor AX.25 traffic. */
'use strict';

const Bunyan = require('bunyan');
const bunyanFormat = require('bunyan-format');
const guts = require('./guts.js');
const raw = require('./raw.js');

const logStream = bunyanFormat({outputMode: 'short', color: false}, process.stderr);
const log = Bunyan.createLogger({
    name: 'monitor',
    level: Bunyan.INFO,
    stream: logStream,
});

try {
    var socket = raw.createSocket({
        logger: log,
    }, function connected() {
    });
    socket.on('error', function(err) {
        log.warn(err);
    });
    socket.on('close', function(err) {
        log.error(err);
        process.exit(1);
    });
    socket.on('packet', function(packet) {
        var line = packet.port + ' ' + packet.fromAddress + '>' + packet.toAddress;
        if (packet.via) {
            line += ' via ';
            for (var v = 0; v < packet.via.length; ++v) {
                if (v > 0) line += ',';
                line += packet.via[v];
            }
        }
        line += ' ' + packet.type;
        if (packet.PID != null) line += ' PID=' + guts.hexByte(packet.PID);
        if (packet.NR != null) line += ' R=' + packet.NR;
        if (packet.NS != null) line += ' S=' + packet.NS;
        if (packet.P) line += ' Poll';
        if (packet.F) line += ' Final';
        if (packet.info) {
            line += ' ' + guts.getDataSummary(packet.info);
            if (packet.info.length > 32) {
                line += ' (' + packet.info.length + ' bytes)';
            }
        }
        log.info(line);
    });
} catch(err) {
    log.error(err);
}
