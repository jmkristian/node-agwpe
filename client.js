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
    if (!options.localAddress) throw newError('no localAddress', 'ERR_INVALID_ARG_VALUE');
    if (!options.remoteAddress) throw newError('no remoteAddress', 'ERR_INVALID_ARG_VALUE');
    const log = options.logger || server.LogNothing;
    const agwOptions = {logger: options.logger};
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
                connection.emit(event, err);
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
    });
    throttle.emitFrameFromAGW = function(frame) {
        connection.onFrameFromAGW(frame);
        if (frame.dataKind == 'C') { // connected
            if (connectListener) connectListener(frame.data);
        }
    };
    receiver.emitFrameFromAGW = function(frame) {
        throttle.onFrameFromAGW(frame);
        if (frame) connection.emit('frameReceived', frame);
        if (frame.dataKind == 'd') { // disconnected
            socket.destroy();
        }
    };
    socket.pipe(receiver);
    sender.pipe(socket);
    assembler.pipe(throttle).pipe(
        // We want to pipe data from the throttle to the sender, but
        // we don't want the sender to end when the throttle ends.
        new Stream.Transform({
            readableObjectMode: true,
            writableObjectMode: true,
            transform: function(chunk, encoding, callback) {
                sender.write(chunk, encoding, callback);
            },
        }));

    throttle.write({dataKind: 'G'}); // ask about ports
    throttle.write({
        port: options.localPort,
        dataKind: 'X', // register call sign
        callFrom: options.localAddress,
    });
    throttle.write({
        port: options.localPort,
        dataKind: 'C', // connect
        callFrom: options.localAddress,
        callTo: options.remoteAddress,
    });
    return connection;
}

exports.createConnection = createConnection;
