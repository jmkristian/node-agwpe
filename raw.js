'use strict';
/** Monitor all received packets and transmit any packet. */
/*
Received data pass through a chain of function calls;
transmitted data flow through a chain of streams.

      Net.Socket
     ------------
       |     ^
       v     |
  Receiver  Sender
       |     ^
       v     |
  PortRouter |
       |     |
       |     |
       |  PortThrottle
       |     ^
       v     |
      RawSocket
*/

const Stream = require('stream');
const guts = require('./guts.js');

/** Exchanges AX.25 packets with remote stations. */
class RawSocket extends Stream.Duplex {

    constructor(options, server) {
        super({
            allowHalfOpen: true,
            decodeStrings: false,
            readableObjectMode: true,
            writableObjectMode: true,
            readableHighWaterMark: options && options.recvBufferSize,
            writableHighWaterMark: options && options.sendBufferSize,
        });
        this.log = guts.getLogger(server.options, this);
        this.log.debug('new(%j, %s)', options, server.constructor.name);
        this.server = server;
        this.isBound = false;
        this.isReading = false;
        const that = this;
        this.listener = function(frame) {
            that.onFrameFromAGW(frame);
        };
        this.once('end', function() {that.isEnded = true;});
        this.once('finish', function() {that.isFinished = true;});
        this.once('close', function() {that.isClosed = true;});
    }

    getRecvBufferSize() {
        return this.readableHighWaterMark;
    }

    getSendBufferSize() {
        return this.writableHighWaterMark;
    }
    
    bind(callback) {
        this.log.debug('bind(%s)', typeof callback);
        try {
            if (this.isBound) {
                throw guts.newError('already bound', 'ERR_SOCKET_ALREADY_BOUND');
            }
            const that = this;
            this.server._connectToAGW(function connected(err) {
                try {
                    if (err) throw err;
                    that.router = that.server.portRouter;
                    that.router.on('rawFrame', that.listener);
                    that.router.on('error', function(err) {
                        that.emit('error', err);
                    });
                    ['close', 'end'].forEach(function(event) {
                        that.router.once(event, function(info) {
                            that.destroy(info);
                        });
                    });
                    that.isBound = true;
                    that.emit('listening');
                    if (callback) callback();
                } catch(err) {
                    this.emit('error', err);
                    if (callback) callback(err);
                }
            });
        } catch(err) {
            this.emit('error', err);
            if (callback) callback(err);
        }
    }

    onFrameFromAGW(frame) {
        try {
            if (frame.dataKind != 'K') {
                throw guts.newError(
                    `frame.dataKind ${frame.dataKind}`,
                    'ERR_INVALID_ARG_TYPE');
            }
            if (this.isReading) {
                const packet = guts.decodePacket(frame.data.slice(1));
                packet.port = frame.port;
                this.log.trace('< %j', packet);
                this.isReading = this.push(packet);
            } else {
                this.log.debug('receive buffer overflow %s', guts.getFrameSummary(frame));
            }
        } catch(err) {
            this.log.debug('onFrameFromAGW(%s)', guts.getFrameSummary(frame));
            this.log.error(err);
            this.emit('error', err);
        }
    }

    _read(size) {
        this.isReading = true;
        // onFrameFromAGW will call this.push, next time a packet arrives.
    }

    _write(packet, encoding, callback) {
        try {
            if ((typeof packet) != 'object') {
                throw guts.newTypeError(`RawSocket._write(${typeof packet})`);
            }
            const p = guts.encodePacket(packet);
            if (this.log.trace()) this.log.trace('_write(%j)', guts.decodePacket(p));
            const data = Buffer.alloc(p.length + 1);
            data[0] = packet.port << 4;
            p.copy(data, 1);
            const frame = {
                port: packet.port,
                dataKind: 'K',
                data: data,
            };
            this.router.getClientFor(frame).write(frame, callback);
        } catch(err) {
            this.emit('error', err);
            if (callback) callback(err);
        }
    }

    _final(callback) {
        this.log.debug('_final(%s)', typeof callback);
        if (callback) callback();
        if (!this.isFinished) this.emit('finish');
    }

    _destroy(err, callback) {
        this.log.debug('_destroy(%s, %s)', err || '', typeof callback);
        if (this.router) {
            this.router.removeListener('rawFrame', this.listener);
            delete this.router;
        }
        if (err) this.emit('error', err);
        if (!this.isFinished) {
            this.end(null, null, callback); // calls _final
        } else if (callback) {
            callback();
        }
        if (!this.isEnded) this.emit('end');
        if (!this.isClosed) this.emit('close');
    }
} // RawSocket

exports.RawSocket = RawSocket;
