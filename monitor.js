/** Monitor AX.25 traffic. This works best with log.level=DEBUG in config.ini. */

const AGW = require('./server');
const Net = require('net');
const log = {
    child: function(){return log;},
    trace: function(){},
    debug: function(){},
    info:  function(message, a, b, c){console.log(' INFO ' + message, a, b, c)},
    warn:  function(message, a, b, c){console.log(' WARN ' + message, a, b, c)},
    error: function(message, a, b, c){console.log('ERROR ' + message, a, b, c)},
    fatal: function(message, a, b, c){console.log('FATAL ' + message, a, b, c)},
};

try {
    var toAGW = new AGW.Writer({logger: log});
    var fromAGW = new AGW.Reader({logger: log});
    var socket = new Net.Socket();
    ['connect', 'close', 'end', 'error', 'lookup', 'ready', 'timeout']
        .forEach(function(event) {
            socket.on(event, function(info) {
                if (info === undefined) {
                    log.info(`socket %s`, event);
                } else {
                    log.info(`socket %s %o`, event, info);
                }
            });
            fromAGW.on(event, function(info) {
                if (info === undefined) {
                    log.info(`fromAGW %s`, event);
                } else {
                    log.info(`fromAGW %s %o`, event, info);
                }
            });
        })
    fromAGW.emitFrameFromAGW = function(frame) {
        if (frame.dataKind == 'G') {
            var parts = frame.data.toString('ascii').split(';');
            var numberOfPorts = parseInt(parts[0], 10);
            for (var p = 0; p < numberOfPorts; ++p) {
                toAGW.write({dataKind: 'm', port: p}); // Monitor
                /*
                  toAGW.write({dataKind: 'M', port: 0, // Send an unproto packet
                  callFrom: Config.AGWPE.myCallSigns[0], callTo: 'ID',
                  data: 'CM87wj'});
                */
            }
        }
    };
    socket.connect({port: 8000});
    socket.pipe(fromAGW);
    toAGW.pipe(socket);
    toAGW.write({dataKind: 'R'}); // Get version of the packet engine
    toAGW.write({dataKind: 'G'}); // Get information about all ports
} catch(err) {
    console.trace(err);
}
