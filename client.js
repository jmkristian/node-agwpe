/** A 'terminal' style command to communicate via AX.25.
    A connection to another station is initiated.
    Subsequently, each line from stdin is transmitted,
    and received data are written to stdout.
    A small command language supports sending and
    receiving files.
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
    const receiver = new server.Reader(agwOptions);
    const sender = new server.Writer(agwOptions);
    const throttle = new server.ConnectionThrottle(agwOptions, connectFrame);
    const dataToFrames = new server.DataToFrames(agwOptions, connectFrame);
    const connection = new server.Connection(dataToFrames, agwOptions);
    const socket = Net.createConnection({
        host: options.host || '127.0.0.1',
        port: options.port || 8000,
    },  function() {
        log.info('Connected to TNC');
    });
    [socket, sender, receiver, throttle, dataToFrames].forEach(function(emitter) {
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
    connection.on('close', function(info) {
        log.trace('connection emitted close(%s)', info || '');
        dataToFrames.end();
    });
    dataToFrames.on('end', function(info) {
        log.trace('dataToFrames emitted end(%s)', info || '');
        throttle.end();
    });
    throttle.on('end', function(info) {
        log.trace('throttle emitted end(%s)', info || '');
        sender.end();
    });
    sender.on('end', function(info) {
        log.trace('sender emitted end(%s)', info || '');
        socket.destroy();
    });
    throttle.emitFrameFromAGW = function(frame) {
        connection.onFrameFromAGW(frame);
    };
    receiver.emitFrameFromAGW = function(frame) {
        if (frame) connection.emit('frameReceived', frame);
        throttle.onFrameFromAGW(frame);
    };
    dataToFrames.pipe(throttle).pipe(sender).pipe(socket);
    socket.pipe(receiver);

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
    if (connectListener) connectListener();
    return connection;
}

exports.createConnection = createConnection;
