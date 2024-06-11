/** Initiate a connection to another station. */

const guts = require('./guts.js');
const Net = require('net');
const server = require('./server.js');
const Stream = require('stream');

const newError = guts.newError;
const validateCallSign = guts.validateCallSign;

class RouterShim {
    constructor(port, throttle, connection, connectListener) {
        this.port = port;
        this.throttle = throttle;
        this.connection = connection;
        this.connectListener = connectListener;
    }
    onFrameFromAGW(frame) {
        switch(frame.dataKind) {
        case 'G': // ports
            try {
                const numberOfPorts = parseInt(frame.data.toString('ascii').split(/;/)[0]);
                if (this.port >= numberOfPorts * 2) {
                    // Multiplying * 2 works around https://github.com/wb2osz/direwolf/issues/515
                    this.connection.emit('error', guts.newRangeError(
                        `The TNC has no port ${this.port}.`, 'ENOENT'));
                }
            } catch(err) {
                this.connection.emit('error', err);
            }
            break;
        case 'X': // registered
            if (!(frame.data && frame.data.toString('binary') == '\x01')) {
                this.connection.emit('error', newError(
                    `The TNC rejected the call sign ${frame.callFrom}`,
                    'ERR_INVALID_ARG_VALUE'));
            }
            break;
        case 'C': // connected
            if (this.connectListener) this.connectListener(frame.data);
            break;
        default:
        }
        this.throttle.onFrameFromAGW(frame);
    }
}

function createConnection(options, connectListener) {
    guts.checkNodeVersion();
    const log = options.logger || guts.LogNothing;
    log.debug('createConnection(%j, %s)',
              Object.assign({}, options, {logger: null}),
              typeof callback);
    const agwOptions = {
        frameLength: options.frameLength,
        ID: options.ID,
        logger: options.logger,
    };
    const localPort = guts.validatePort(options.localPort || 0);
    const localAddress = validateCallSign('local', options.localAddress);
    const remoteAddress = validateCallSign('remote', options.remoteAddress);
    const via = guts.validatePath(options.via);
    const connectFrame = {
        port: localPort,
        callTo: localAddress,
        callFrom: remoteAddress,
    };
    const receiver = new guts.Receiver(agwOptions);
    const sender = new guts.Sender(agwOptions);
    const throttle = new server.ConnectionThrottle(agwOptions, sender, connectFrame);
    const assembler = new server.FrameAssembler(agwOptions, connectFrame);
    const connection = new server.Connection(agwOptions, assembler);
    throttle.client = connection;
    receiver.client = new RouterShim(localPort, throttle, connection, connectListener);
    const that = this;
    const socket = Net.createConnection({
        host: options.host || '127.0.0.1',
        port: options.port || 8000,
    },  function() {
        log.debug('Connected to TNC');
    });
    [socket, sender, receiver, throttle, assembler].forEach(function(emitter) {
        const emitterClass = emitter.constructor.name;
        ['error', 'timeout'].forEach(function(event) {
            emitter.on(event, function(err) {
                log.debug('%s emitted %s(%s)', emitterClass, event, err || '');
                connection.emit(event, err);
            });
        });
        ['end', 'close'].forEach(function(event) {
            emitter.on(event, function(err) {
                log.debug('%s emitted %s(%s)', emitterClass, event, err || '');
            });
        });
    });
    throttle.on('close', function(info) {
        socket.destroy();
    });
    socket.on('close', function(info) {
        connection.destroy(info);
    });
    socket.pipe(receiver);
    sender.pipe(socket);
    assembler.pipe(throttle);
    connection.on('connected', function(data) {
        throttle.write(throttle.queryFramesInFlight());
    });
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
