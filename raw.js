/** Utilities for exchanging data via AGWPE and AX.25 UI frames. */
/*
Received data pass through a chain of function calls;
transmitted data flow through a pipeline of Transform
streams, like this:

       Net.Socket
     --------------
       |       ^
       v       |
    Receiver Sender
       |       ^
       v       |
      raw.Socket

*/

const EventEmitter = require('events');
const guts = require('./guts.js');
const Net = require('net');

/** Exchanges UI frames with remote stations. */
class Socket extends EventEmitter {

    constructor(sender, options) {
        super();
        this.log = guts.getLogger(options, this);
        this.log.trace('new(%s)', options);
        this.sender = sender;
        this.localAddress = sender.myCall;
        this._closed = false;
    }

    onFrameFromAGW(frame) {
        try {
            if (frame.dataKind != 'K') {
                // We should not receive that frame type.
                this.emit('error', 'received ' + getFrameSummary(frame));
            } else {
                var packet = guts.decodePacket(frame.data.slice(1));
                packet.port = frame.port;
                this.emit('packet', packet);
            }
        } catch(err) {
            this.emit('error', err);
        }
    }

    send(packet, callback) {
        this.log.trace('send(%s)', packet);
        guts.validatePort(packet.port);
        const p = guts.encodePacket(packet);
        this.log.trace('send packet ' + guts.hexBuffer(p));
        this.log.trace('send packet %s', guts.decodePacket(p));
        const data = Buffer.alloc(p.length + 1);
        data[0] = packet.port << 4;
        p.copy(data, 1);
        this.sender.write({
            dataKind: 'K',
            port: packet.port,
            data: data,
        }, callback);
    }
} // Socket

function createSocket(options, connectListener) {
    guts.checkNodeVersion();
    const log = options.logger || guts.LogNothing;
    log.debug('createSocket(%j)', Object.assign({}, options, {logger: null}));
    const agwOptions = {
        frameLength: options.frameLength,
        logger: options.logger,
    };
    const receiver = new guts.Receiver(agwOptions);
    const sender = new guts.Sender(agwOptions);
    const netSocket = Net.createConnection({
        host: options.host || '127.0.0.1',
        port: options.port || 8000,
    }, function() {
        log.debug('Connected to TNC'); 
        netSocket.pipe(receiver);
        sender.pipe(netSocket);
        sender.write({dataKind: 'k'}); // enable reception of K frames
        if (connectListener) connectListener();
    });
    socket = new Socket(sender, options);
    [netSocket, sender, receiver].forEach(function(emitter) {
        ['error', 'close'].forEach(function(event) {
            emitter.on(event, function(err) {
                log.debug('%s emitted %s(%s)', emitter.constructor.name, event, err || '');
                socket.emit(event, err);
            });
        });
        emitter.on('finish', function(err) {
            log.debug('%s emitted %s(%s)', emitter.constructor.name, event, err || '');
            socket.emit('close', err);
        });
    });
    netSocket.on('close', function(info) {
        log.trace('netSocket emitted close(%s)', info || '');
        socket.destroy();
    });
    receiver.emitFrameFromAGW = function(frame) {
        socket.onFrameFromAGW(frame);
    };
    return socket;
}

exports.createSocket = createSocket;
