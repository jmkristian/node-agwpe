/** A command to communicate via AX.25 in 'terminal' style.
    A connection to another station is initiated. Subsequently, each
    line from stdin is transmitted, and received data are written to
    stdout. A small command language supports sending and receiving
    files.
 */
const Net = require('net');
const server = require('./server.js');
const Stream = require('stream');
const newError = server.newError;

const charset = 'utf-8';

function createConnection(options, connectListener) {
    server.checkNodeVersion();
    if (!options.localAddress) throw newError('no localAddress', 'ERR_INVALID_ARG_VALUE');
    if (!options.remoteAddress) throw newError('no remoteAddress', 'ERR_INVALID_ARG_VALUE');
    const log = options.logger || server.LogNothing;
    log.debug('createConnection(%j)', Object.assign({}, options, {logger: null}));
    const agwOptions = {
        frameLength: options.frameLength,
        ID: options.ID,
        logger: options.logger,
    };
    const via = !options.via ? [] :
          (Array.isArray(options.via) ? options.via : (options.via + '').trim().split(/[\s,]+/))
          .map(function(v) { // all strings
              return (v == null) ? '' : (v + '');
          })
          .filter(function(v) { // no strings empty or too long
              if (v.length > 9) {
                  throw newError(`The digipeater call sign ${v} is longer than the maximum 9 characters.`,
                                 'ERR_INVALID_ARG_VALUE');
              }
              return v != '';
          });
    if (via.length > 7) {
        throw newError(`${via.length} digipeaters exceeds the maximum 7.`,
                       'ERR_INVALID_ARG_VALUE');
    }
    const connectFrame = {
        port: options.localPort || 0,
        callTo: options.localAddress,
        callFrom: options.remoteAddress,
    };
    const receiver = new server.Receiver(agwOptions);
    const sender = new server.Sender(agwOptions);
    const throttle = new server.ConnectionThrottle(agwOptions, connectFrame);
    const assembler = new server.FrameAssembler(agwOptions, connectFrame);
    const connection = new server.Connection(assembler, agwOptions);
    const socket = Net.createConnection({
        host: options.host || '127.0.0.1',
        port: options.port || 8000,
    },  function() {
        log.debug('Connected to TNC');
    });
    [socket, sender, receiver, throttle, assembler].forEach(function(emitter) {
        ['error', 'timeout'].forEach(function(event) {
            emitter.on(event, function(err) {
                log.debug('%s emitted %s(%s)', emitter.constructor.name, event, err || '');
                connection.emit(event, err);
            });
        });
        ['finish', 'close'].forEach(function(event) {
            emitter.on(event, function(err) {
                log.debug('%s emitted %s(%s)', emitter.constructor.name, event, err || '');
            });
        });
    });
    socket.on('close', function(info) {
        log.trace('socket emitted close(%s)', info || '');
        connection.destroy();
    });
    connection.on('finish', function(info) {
        log.trace('connection emitted finish(%s)', info || '');
        assembler.end();
    });
    assembler.on('end', function(info) {
        log.trace('assembler emitted end(%s)', info || '');
        throttle.end();
    });
    throttle.on('end', function(info) {
        log.trace('throttle emitted end(%s)', info || '');
        // sender.end(); // Don't do that.
        // We might still be waiting to receive a 'd' disconnect frame.
        // In which case we don't want the sender and socket to end.
    });
    throttle.on('close', function(info) {
        log.debug('throttle emitted close(%s)', info || '');
        connection.destroy();
        socket.destroy();
    });
    throttle.emitFrameFromAGW = function(frame) {
        connection.onFrameFromAGW(frame);
        switch(frame.dataKind) {
        case 'G': // ports
            try {
                const numberOfPorts = parseInt(frame.data.toString('ascii').split(/;/)[0]);
                if (options.localPort >= numberOfPorts) {
                    connection.emit('error', newError(
                        `The TNC has no port ${options.localPort}`,
                        'ERR_INVALID_ARG_VALUE'));
                }
            } catch(err) {
                connection.emit('error', err);
            }
            break;
        case 'X': // registered
            if (!(frame.data && frame.data.toString('binary') == '\x01')) {
                connection.emit('error', newError(
                    `The TNC rejected the call sign ${options.localAddress}`,
                    'ERR_INVALID_ARG_VALUE'));
            }
            break;
        case 'C': // connected
            if (connectListener) connectListener(frame.data);
        default:
        }
    };
    receiver.emitFrameFromAGW = function(frame) {
        throttle.onFrameFromAGW(frame);
        if (frame) connection.emit('frameReceived', frame);
    };
    socket.pipe(receiver);
    sender.pipe(socket);
    assembler.pipe(throttle).pipe(new server.FramesTo(sender));
    // We want to pipe data from the throttle to the sender, but
    // we don't want the sender and socket to end when the throttle ends,
    // in case we're waiting to receive a 'd' disconnect frame.

    throttle.write({dataKind: 'G'}); // ask about ports
    throttle.write({
        port: options.localPort,
        dataKind: 'X', // register call sign
        callFrom: options.localAddress,
    });
    if (via.length <= 0) {
        throttle.write({
            dataKind: 'C', // connect
            port: options.localPort,
            callFrom: options.localAddress,
            callTo: options.remoteAddress,
        });
    } else {
        const data = Buffer.alloc(1 + (10 * via.length));
        data[0] = via.length;
        for (var v = 0; v < via.length; ++v) {
            data.write(via[v].toUpperCase(), 1 + (10 * v), via[v].length, 'ascii');
        }
        throttle.write({
            dataKind: 'v', // connect via digipeaters
            port: options.localPort,
            callFrom: options.localAddress,
            callTo: options.remoteAddress,
            data: data,
        });
    }
    return connection;
}

exports.createConnection = createConnection;
