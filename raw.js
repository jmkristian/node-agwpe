'use strict';
/** Monitor all received packets and transmit any packet. */
/*
Received data pass through a chain of function calls;
transmitted data flow through a pipeline of Transform
streams, like this:

        Net.Socket
     ----------------
       |         ^
       v         |
    Receiver   Sender
       |         ^
       v         |
     PortRouter  |
            |    |
            v    |
         PortThrottle
            |    ^
            v    |
           RawSocket
*/

const Stream = require('stream');
const guts = require('./guts.js');

/** Exchanges AX.25 packets with remote stations. */
class RawSocket extends Stream.Duplex {

    constructor(server, options) {
        super({
            allowHalfOpen: false,
            decodeStrings: false,
            readableObjectMode: true,
            writableObjectMode: true,
            readableHighWaterMark: options && options.recvBufferSize,
            writableHighWaterMark: options && options.sendBufferSize,
        });
        this.server = server;
        this.log = guts.getLogger(server.options, this);
        this.log.debug('new(%s)', server.constructor.name);
        this.recvBuffer = [];
        this.reading = false;
        this.bound = false;
        this.closed = false;
        const that = this;
        this.listener = function(frame) {
            that.onFrameFromAGW(frame);
        };
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
            if (this.bound) {
                throw guts.newError('already bound', 'ERR_SOCKET_ALREADY_BOUND');
            }
            const that = this;
            this.server._connectToAGW(function connected(err) {
                if (err) {
                    that.destroy(err);
                } else {
                    that.throttle = that.server.portRouter.getClientFor({port: 0});
                    // The port doesn't really matter. Any old throttle is fine.
                    if (!that.throttle) {
                        that.emit('error', 'no throttle');
                    } else {
                        that.bound = true;
                        that.throttle.on('rawFrame', that.listener);
                        that.throttle.on('error', function(err) {
                            that.emit('error', err);
                        });
                        ['close', 'end', 'finish'].forEach(function(event, info) {
                            that.throttle.on(event, function(info) {
                                that.destroy(info);
                            });
                        });
                        that.emit('listening');
                        if (callback) callback();
                    }
                }
            });
        } catch(err) {
            this.emit('error', err);
        }
    }

    onFrameFromAGW(frame) {
        this.log.trace('onFrameFromAGW(%s)', frame && frame.dataKind);
        try {
            if (frame.dataKind != 'K') {
                // We should not receive that frame type.
                throw(guts.newError(
                    `frame.dataKind ${frame.dataKind}`,
                    'ERR_INVALID_ARG_TYPE'));
            }
            const packet = guts.decodePacket(frame.data.slice(1));
            this.log.trace('onFrameFromAGW(%s)', packet);
            packet.port = frame.port;
            if (this.recvBuffer.length < this.readableHighWaterMark) {
                this.recvBuffer.push(packet);
                while (this.reading && this.recvBuffer.length > 0) {
                    this.reading = this.push(this.recvBuffer.shift());
                }
            }
        } catch(err) {
            this.log.error(err);
            this.emit('error', err);
        }
    }

    _read(size) {
        for(this.reading = true; this.reading && this.recvBuffer.length > 0; ) {
            this.reading = this.push(this.recvBuffer.shift());
        }
    }

    _write(packet, encoding, callback) {
        switch(typeof packet) {
        case 'object':
            try {
                const p = guts.encodePacket(packet);
                if (this.log.trace()) this.log.trace('_write(%s)', guts.decodePacket(p));
                const data = Buffer.alloc(p.length + 1);
                data[0] = packet.port << 4;
                p.copy(data, 1);
                this.throttle.write({
                    dataKind: 'K',
                    port: packet.port,
                    data: data,
                }, callback);
            } catch(err) {
                if (callback) callback(err);
            }
            break;
        default:
            if (callback) callback(guts.newError(
                `RawSocket write(${typeof packet})`,
                'ERR_INVALID_ARG_TYPE'
            ));
        }
    }

    _final(callback) {
        if (this.throttle) {
            this.throttle.removeListener('rawFrame', this.listener);
            delete this.throttle;
        }
        if (!this.closed) {
            this.closed = true;
            this.emit('end');
            this.emit('close');
        }
        if (callback) callback();
    }

    _destroy(err, callback) {
        this.log.debug('_destroy(%s)', err || '');
        if (err && !this.closed) {
            this.emit('error', err);
        }
        _final(callback);
    }
} // RawSocket

exports.RawSocket = RawSocket;
