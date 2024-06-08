/** Initiate a connection to another station. */

const guts = require('./guts.js');
const Net = require('net');
const server = require('./server.js');
const Stream = require('stream');

const newError = guts.newError;
const validateCallSign = guts.validateCallSign;
const validatePort = guts.validatePort;

function createConnection(options, connectListener) {
    guts.checkNodeVersion();
    const log = options.logger || guts.LogNothing;
    log.debug('createConnection(%j)', Object.assign({}, options, {logger: null}));
    const agwOptions = {
        frameLength: options.frameLength,
        ID: options.ID,
        logger: options.logger,
    };
    const localPort = validatePort(options.localPort);
    const localAddress = validateCallSign('local', options.localAddress);
    const remoteAddress = validateCallSign('remote', options.remoteAddress);
    const via = guts.validatePath(options.via);
    const connectFrame = {
        port: localPort || 0,
        callTo: localAddress,
        callFrom: remoteAddress,
    };
    const receiver = new guts.Receiver(agwOptions);
    const sender = new guts.Sender(agwOptions);
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
                if (localPort >= numberOfPorts) {
                    connection.emit('error', newError(
                        `The TNC has no port ${localPort}`,
                        'ERR_INVALID_ARG_VALUE'));
                }
            } catch(err) {
                connection.emit('error', err);
            }
            break;
        case 'X': // registered
            if (!(frame.data && frame.data.toString('binary') == '\x01')) {
                connection.emit('error', newError(
                    `The TNC rejected the call sign ${localAddress}`,
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
        port: localPort,
        dataKind: 'X', // register call sign
        callFrom: localAddress,
    });
    throttle.write(guts.connectFrame(localPort, localAddress, remoteAddress, via));
    return connection;
}

exports.createConnection = createConnection;
