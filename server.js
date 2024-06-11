/** Utilities for exchanging data via AGWPE and AX.25. */
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
    PortRouter   |
            |    |
            v    |
         PortThrottle
            |    ^
            v    |
ConnectionRouter |
            |    |
            v    |
      ConnectionThrottle
            |    ^
            |    |
            | FrameAssembler
            |    ^
            v    |
          Connection

When an AX.25 connection is disconnected, the Connection calls
FrameAssembler.end(). As usual for a pipeline, this eventually
calls ConnectionThrottle.end().
*/

const EventEmitter = require('events');
const guts = require('./guts.js');
const Net = require('net');
const process = require('process');
const RawSocket = require('./raw.js').RawSocket;
const Stream = require('stream');

const copyBuffer = guts.copyBuffer;
const DefaultFrameLength = guts.DefaultFrameLength;
const getDataSummary = guts.getDataSummary;
const getFrameSummary = guts.getFrameSummary;
const getLogger = guts.getLogger;
const HeaderLength = guts.HeaderLength;
const hexBuffer = guts.hexBuffer;
const newError = guts.newError;

const KByte = 1 << 10;

function validateHosts(hosts) {
    var result = Array.isArray(hosts)
        ? hosts.map(function(host) {
            return guts.validateCallSign('local', host);
        })
        : [guts.validateCallSign('local', hosts)];
    if (result.length <= 0) {
        throw newError(`no local call signs`, 'ERR_INVALID_ARG_VALUE');
    }
    return result;
}

function validatePorts(ports) {
    if (ports == null) return undefined;
    var result = Array.isArray(ports)
        ? ports.map(guts.validatePort)
        : [guts.validatePort(ports)];
    if (result.length <= 0) return undefined;
    return result;
}

function flattenArray(a) {
    return a.length <= 0 ? undefined : a.length == 1 ? a[0] : a;
}

function mergeOptions(from) {
    var args = Array.from(arguments);
    var into = {};
    args.splice(0, 0, into);
    Object.assign.apply(Object, args);
    return into;
}

const EmptyBuffer = Buffer.alloc(0);

/** Creates a client object to handle each connection to an AGW port
    or a remote AX.25 station. Also, passes frames received via each
    connection to the client that handles that connection.
*/
class Router extends EventEmitter {

    constructor(toAGW, fromAGW, options, server) {
        super();
        this.log = getLogger(options, this);
        this.log.trace('new(%s)', options);
        this.toAGW = toAGW;
        this.fromAGW = fromAGW;
        this.options = options;
        this.server = server;
        this.clients = {};
        fromAGW.client = this;
        const that = this;
        ['error', 'timeout'].forEach(function(event) {
            fromAGW.on(event, function(info) {
                for (const c in that.clients) {
                    that.clients[c].emit(event, info);
                }
            });
        });
        const fromAGWClass = fromAGW.constructor.name;
        fromAGW.on('close', function(err) {
            that.log.debug('%s emitted close(%s); destroy clients', fromAGWClass, err || '');
            for (const c in that.clients) {
                that.clients[c].destroy();
            }
            that.emit('close', err);
        });
        fromAGW.on('end', function(err) {
            that.log.trace('%s emitted end(%s)', fromAGWClass, err || '');
        });
    }

    onFrameFromAGW(frame) {
        try {
            const client = this.getClientFor(frame);
            if (client) {
                if (this.log.trace()) {
                    this.log.trace('routeFrameFromAGW(%s)', getFrameSummary(frame));
                }
                this.routeFrameFromAGW(frame, client); // Delegate to a subclass.
            }
        } catch(err) {
            this.emit('error', err);
        }
    }

    getClientFor(frame) {
        const that = this;
        const key = this.getKey(frame);
        var client = this.clients[key];
        if (!client) {
            client = this.newClient(frame);
            if (client) {
                this.clients[key] = client;
                const clientClass = client.constructor.name;
                client.on('close', function(info) {
                    that.log.debug('%s emitted close(%s); delete client[%s]',
                                   clientClass, info || '', key);
                    delete that.clients[key];
                });
            } else {
                const myClass = this.constructor.name;
                throw(`${myClass}.clients[${key}] == ${client}`);
            }
        }
        return client;
    }

} // Router

/** Manages objects that handle data to and from each AGW port. */
class PortRouter extends Router {

    constructor(toAGW, fromAGW, options, server) {
        super(toAGW, fromAGW, options, server);
        this.log.debug(
            'new(%s, %s, %s, %s)',
            toAGW.constructor.name,
            fromAGW.constructor.name,
            options,
            server.constructor.name)
        const that = this;
        this.on('newListener', function(event, listener) {
            if (event == 'rawFrame' && that.listenerCount('rawFrame') == 0) {
                toAGW.write({dataKind: 'k'}); // enable reception of K frames
            }
        });
        this.on('removeListener', function(event, listener) {
            if (event == 'rawFrame' && that.listenerCount('rawFrame') == 0) {
                toAGW.write({dataKind: 'k'}); // disable reception of K frames
            }
        });
    }

    getKey(frame) {
        return frame.port;
    }

    newClient(frame) {
        var throttle = new PortThrottle(this.options, this.toAGW, frame);
        var router = new ConnectionRouter(throttle, throttle, this.options, this.server);
        throttle.write(throttle.queryFramesInFlight());
        // The response will initialize throttle.inFlight.
        return throttle;
    }

    routeFrameFromAGW(frame, client) {
        const that = this;
        switch(frame.dataKind) {
        case 'G': // available ports
            try {
                const parts = frame.data.toString('ascii').split(';');
                const ports = [];
                const numberOfPorts = parseInt(parts[0]);
                for (var p = 0; p < numberOfPorts; ++p) {
                    ports.push(p);
                }
                ports.forEach(function(port) {
                    that.toAGW.write({dataKind: 'g', port: port});
                });
                this.server.setPorts(ports);
            } catch(err) {
                this.server.emit('error', err);
            }
            break;
        case 'X': // registered myCall
            const myCall = frame.callFrom;
            const code = frame.data && frame.data.length > 0 && frame.data[0];
            const err = (code == 1) ? null : newError(
                `Failed to register ${myCall} with the TNC (code ${code}).`,
                'EACCES');
            if (err) err.address = myCall;
            this.emit('registeredCall', err || myCall);
            break;
        case 'K':
            this.emit('rawFrame', frame);
            break;
        default:
            client.onFrameFromAGW(frame);
        }
    }
} // PortRouter

/** Manages objects that handle data to and from each remote station via AX.25. */
class ConnectionRouter extends Router {

   constructor(toAGW, fromAGW, options, server) {
        super(toAGW, fromAGW, options, server);
    }

    getKey(frame) {
        const key = (frame.dataKind == 'Y')
              ? `${frame.port} ${frame.callTo} ${frame.callFrom}`
              : `${frame.port} ${frame.callFrom} ${frame.callTo}`;
        if (frame.dataKind == 'sendConnection' && this.clients[key]) {
            throw newError(
                `${frame.callTo} is already connected to ${frame.callFrom}.`,
                'EADDRINUSE');
        }
        return key;
    }

    newClient(frame) {
        switch(frame.dataKind) {
        case 'sendConnection':
        case 'C': // received connection
            break;
        default: // unexpected
            this.log.warn('ConnectionRouter.newClient(dataKind: %s)', frame.dataKind);
            return null;
        }
        const throttle = new ConnectionThrottle(this.options, this.toAGW, frame);
        const dataToFrames = new FrameAssembler(this.options, frame);
        dataToFrames.pipe(throttle);
        const connection = new Connection(this.options, dataToFrames);
        throttle.client = connection;
        const connectionClass = connection.constructor.name;
        const dataToFramesClass = dataToFrames.constructor.name;
        const throttleClass = throttle.constructor.name;
        const that = this;
        ['error', 'timeout'].forEach(function(event) {
            throttle.on(event, function(info) {
                that.log.trace('%s emitted %s; %s.emit %s',
                               throttleClass, event, connectionClass, event);
                connection.emit(event, info);
            });
        });
        if (frame.dataKind == 'C') { // received connection
            connection.on('connected', function(data) {
                throttle.write(throttle.queryFramesInFlight());
                that.server.emit('connection', connection);
            });
        }
        return throttle;
    }

    routeFrameFromAGW(frame, client) {
        client.onFrameFromAGW(frame);
        // Disconnect frames are handled by the client.
    }
} // ConnectionRouter

const MaxFramesInFlight = 8;

/** Delay transmission of frames, to avoid overwhelming AGWPE.
    The frames aren't changed, merely delayed.
*/
class Throttle extends Stream.Writable {
    /* This was a Stream.Transform, but that didn't work out.
       One problem was it couldn't control the Readable buffer.
       It wasn't possible to know how many frames were buffered, so
       the flow control (using 'k' and 'K' frames) was inaccurate.
       Also, Stream.Transform deleted frames from the Readable buffer,
       around the time _flush was called. Consequently, the last
       frames to be sent ('d' disconnect or 'M' for ID) were not sent.

       Another problem was when a client called end(), the Transform
       ultimately called end() on the next stream in the pipeline,
       that is a PortThrottle or Sender, which horked its other clients.

       So, this Writable manages its own buffer of frames to send,
       and interacts with the next stream in the pipeline using
       sender.send(), sender.isFull and the 'notFull' event.
    */

    constructor(options, sender) {
        super({
            objectMode: true,
            highWaterMark: 5,
        });
        this.log = getLogger(options, this);
        this.log.trace('new %j', mergeOptions(options, {logger: undefined}));
        this.sender = sender;
        this.buffer = []; // Frames waiting to be sent, and related stuff.
        /* In some cases, Direwolf starts a connection with Y=1, mysteriously.
           See https://github.com/wb2osz/direwolf/issues/535.
           To work around this bug, we start with: */
        this.inFlight = 1;
        this.minInFlight = 1;
        this.maxInFlight = MaxFramesInFlight;
        const that = this;
        sender.on('notFull', function() {
            that.sendBuffer();
        });
        this.once('close', function() {that.isClosed = true;});
        this.on('pipe', function(from) {
            that.log.trace('pipe from %s', from.constructor.name);
        });
        this.on('unpipe', function(from) {
            that.log.trace('unpipe from %s', from.constructor.name);
        });
    }

    updateFramesInFlight(frame) {
        this.inFlight = frame.data.readUInt32LE(0);
        this.log.trace('inFlight = %d', this.inFlight);
        if (this.minInFlight > this.inFlight) {
            this.minInFlight = this.inFlight;
        }
        this.sendBuffer();
    }

    sendBuffer() {
        this.log.trace('sendBuffer %d', this.buffer.length);
        const that = this;
        while (this.buffer.length > 0) {
            if ((typeof this.buffer[0]) == 'function') {
                // Call a callback:
                this.buffer.shift()();
            } else if (this.sender.isFull) {
                // Try again after sender emits 'notFull'.
                break;
            } else if (this.inFlight >= this.maxInFlight) {
                // Wait until inFlight decreases.
                if (!this.polling) {
                    this.log.trace('start polling');
                    this.polling = setInterval(function() {
                        that.pushFrame(that.queryFramesInFlight());
                    }, 2000);
                }
                break;
            } else {
                // Push a frame:
                this.pushFrame(this.buffer.shift());
                this.stopPolling();
            }
        }
    }

    pushFrame(frame) {
        if (frame != null) {
            this.sender.send(frame);
            switch(frame.dataKind) {
            case 'D': // connected data
            case 'K': // raw AX.25 data
            case 'M': // UNPROTO data
            case 'V': // UNPROTO VIA
                ++this.inFlight;
                if (!this.sender.isFull && this.inFlight == this.maxInFlight / 2) {
                    // Look ahead, to possibly avoid polling later:
                    this.sender.send(this.queryFramesInFlight());
                }
                break;
            default:
                // non-data frames don't count
            }
        }
    }

    stopPolling() {
        if (this.polling) {
            this.log.trace('stop polling');
            clearInterval(this.polling);
            this.polling = null;
        }
    }

    _write(frame, encoding, callback) {
        this.log.trace('_write(%s, %s, %s)', typeof frame, encoding, typeof callback);
        this.buffer.push(frame);
        if (callback) this.buffer.push(callback);
        this.sendBuffer();
    }

    _final(callback) {
        try {
            this.log.debug('_final(%s)', typeof callback);
            const that = this;
            if (this.bufferFinalFrames) {
                this.bufferFinalFrames();
            }
            this.buffer.push(function() {
                that.stopPolling();
            });
            if (callback) callback();
        } catch(err) {
            if (callback) callback(err);
        }
        this.sendBuffer();
    }

    _destroy(err, callback) {
        this.log.debug('_destroy(%s, %s)', err || '', typeof callback);
        if (!this.isClosed) this.emit('close');
        if (callback) callback();
    }
} // Throttle

/* Limit the rate of frames to an AGW port. */
class PortThrottle extends Throttle {

    constructor(options, sender, frame) {
        super(options, sender);
        this.port = frame.port;
        // Each connection and RawSocket adds listeners to this.
        // The number of possible connections is very large, so:
        this.setMaxListeners(0); // unlimited
        const that = this;
        /** A ConnectionThrottle.sender may be a PortThrottle. */
        this.isFull = false;
        this.on('drain', function() {
            that.isFull = false;
            that.emit('notFull');
        });
    }

    send(frame) {
        this.isFull = !this.write(frame);
    }

    queryFramesInFlight() {
        return {
            dataKind: 'y',
            port: this.port,
        };
    }

    onFrameFromAGW(frame) {
        switch(frame.dataKind) {
        case 'g': // capabilities of this port
            break;
        case 'y': // frames waiting to be transmitted
            this.updateFramesInFlight(frame);
            break;
        default:
            this.client.onFrameFromAGW(frame);
        }
    }
} // PortThrottle

/* Limit the rate of frames to an AX.25 connection. */
class ConnectionThrottle extends Throttle {

    constructor(options, sender, frame) {
        super(options, sender);
        this.port = frame.port;
        this.myCall = frame.callTo;
        this.theirCall = frame.callFrom;
        this.ID = options.ID;
    }

    queryFramesInFlight(id) {
        return {
            dataKind: 'Y',
            port: this.port,
            callTo: this.theirCall,
            callFrom: this.myCall,
        };
    }

    onFrameFromAGW(frame) {
        const that = this;
        switch(frame.dataKind) {
        case 'Y': // frames waiting to be transmitted
            this.updateFramesInFlight(frame);
            break;
        case 'd': // disconnected
            this.log.trace('received d frame');
            this._disconnected = true;
            this.client.onFrameFromAGW(frame);
            /* You can't send any more data. Discard it: */
            this.buffer = this.buffer.filter(function(item) {
                return !((typeof item) == 'object' && item.dataKind == 'D');
            });
            if (this.ID) {
                this.log.debug('buffer.push ID');
                this.buffer.push({
                    dataKind: 'M', // UNPROTO
                    port: this.port,
                    callTo: 'ID',
                    callFrom: this.myCall,
                    data: Buffer.from(this.ID + '', 'latin1'),
                });
            }
            this.buffer.push(function() {
                that.destroy(); // Causes the router to delete this client.
            });
            this.sendBuffer();
            break;
        default:
            this.client.onFrameFromAGW(frame);
        }
    }

    bufferFinalFrames() {
        if (!this._disconnected) {
            this._disconnected = true;
            this.log.debug('buffer.push disconnect');
            const that = this;
            this.buffer.push(function() {
                // Wait until there are no more data frames in flight
                // (so they won't be obliterated by disconnecting).
                that.maxInFlight = that.minInFlight + 1;
            });
            // Then send the disconnect:
            this.buffer.push({
                dataKind: 'd', // disconnect
                port: this.port,
                callFrom: this.myCall,
                callTo: this.theirCall,
            });
            // And allow sending more frames:
            this.buffer.push(function() {
                that.maxInFlight = MaxFramesInFlight;
            });
        }
    }
} // ConnectionThrottle

const MaxWriteDelay = 250; // msec

/** Transform a stream of data to a stream of AGW frames.
    To promote efficient transmission, data may be delayed for as long as
    MaxWriteDelay, while several chunks are combined into one AGW data frame,
    perhaps as long as options.frameLength.
*/
class FrameAssembler extends Stream.Transform {

    constructor(options, frame) {
        super({
            allowHalfOpen: false,
            emitClose: false,
            readableObjectMode: true,
            readableHighWaterMark: 1,
            writableObjectMode: false,
            writableHighWaterMark: ((options && options.frameLength) || DefaultFrameLength),
        });
        this.log = getLogger(options, this);
        this.log.trace('new %j, %j', mergeOptions(options, {logger: undefined}), frame);
        this.port = frame.port;
        this.myCall = frame.callTo;
        this.theirCall = frame.callFrom;
        this.ID = options.ID;
        this.maxDataLength = (options && options.frameLength) || DefaultFrameLength;
        this.bufferCount = 0;
        const that = this;
        this.on('pipe', function(from) {
            that.log.trace('pipe from %s', from.constructor.name);
        });
        this.on('unpipe', function(from) {
            that.log.trace('unpipe from %s', from.constructor.name);
        });
    }

    _transform(data, encoding, afterTransform) {
        try {
            if (!Buffer.isBuffer(data)) {
                afterTransform(newError(`FrameAssembler._transform ${typeof data}`,
                                        'ERR_INVALID_ARG_TYPE'));
                return;
            }
            if (this.log.trace()) {
                this.log.trace(`_transform %s length %d`, getDataSummary(data), data.length)
            }
            if (this.bufferCount + data.length < this.maxDataLength) {
                if (this.buffer == null) {
                    this.buffer = Buffer.alloc(this.maxDataLength);
                    this.bufferCount = 0;
                }
                data.copy(this.buffer, this.bufferCount);
                this.bufferCount += data.length;
                afterTransform();
                // Start the timeout, if it's not already running:
                if (this.timeout == null) {
                    this.timeout = setTimeout(function(that) {
                        that.timeout = null;
                        that.sendBuffer();
                    }, MaxWriteDelay, this);
                }
            } else {
                // Push some data to AGW:
                /* Direwolf will split a frame into several AX.25 packets,
                   but it won't combine frames into one packet. So, it
                   pays to push part of data in one frame with this.buffer,
                   and push the remaining data in the next frame.
                */
                var dataNext = (this.buffer == null) ? 0 :
                    this.buffer.length - this.bufferCount;
                if (dataNext > 0) {
                    data.copy(this.buffer, this.bufferCount, 0, dataNext);
                    this.bufferCount += dataNext;
                }
                this.sendBuffer(); // stops the timeout
                for (; dataNext < data.length; dataNext += this.maxDataLength) {
                    var dataEnd = dataNext + this.maxDataLength;
                    if (dataEnd <= data.length) {
                        this.pushFrame(data.subarray(dataNext, dataEnd));
                    } else {
                        this.buffer = Buffer.alloc(this.maxDataLength);
                        this.bufferCount = data.length - dataNext;
                        data.copy(this.buffer, 0, dataNext);
                        // Restart the timeout:
                        this.timeout = setTimeout(function(that) {
                            that.timeout = null;
                            that.sendBuffer();
                        }, MaxWriteDelay, this);
                        break;
                    }
                }
                afterTransform();
            }
        } catch(err) {
            afterTransform(err);
        }
    }

    _flush(callback) {
        this.log.debug(`_flush(%s)`, typeof callback);
        this.sendBuffer();
        callback();
    }

    sendBuffer() {
        if (this.timeout != null) {
            clearTimeout(this.timeout);
            this.timeout = null;
        }
        if (this.bufferCount > 0) {
            var data = this.buffer.subarray(0, this.bufferCount);
            // The callback might ultimately call this._transform,
            // which might add more data into this.buffer or call
            // this.sendBuffer again. To prevent confusion:
            this.bufferCount = 0;
            this.buffer = null;
            this.pushFrame(data);
        }
    }

    pushFrame(data) {
        if (data.length > 0) {
            var frame = {
                dataKind: 'D',
                port: this.port,
                callFrom: this.myCall,
                callTo: this.theirCall,
                data: data,
            };
            if (this.log.trace()) {
                this.log.trace('push %s', getFrameSummary(frame));
            }
            this.push(frame);
        }
    }
} // FrameAssembler

/** Exchanges bytes between one local call sign and one remote call sign. */
class Connection extends Stream.Duplex {

    constructor(options, toAGW) {
        super({
            allowHalfOpen: true,
            emitClose: false, // emitClose: true doesn't always emit close.
            readableObjectMode: false,
            readableHighWaterMark: 4 * KByte,
            writableObjectMode: false,
            writableHighWaterMark: 2 * ((options && options.frameLength) || DefaultFrameLength),
        });
        this.log = getLogger(options, this);
        this.log.trace('new %s, %j',
                       toAGW.constructor.name,
                       mergeOptions(options, {logger: undefined}));
        this.ID = options.ID;
        this.toAGW = toAGW;
        this.port = toAGW.port;
        this.localAddress = toAGW.myCall;
        this.remoteAddress = toAGW.theirCall;
        this._pushable = false;
        const that = this;
        this.once('end', function() {that.isEnded = true;});
        this.once('close', function() {that.isClosed = true;});
        this.on('pipe', function(from) {
            that.log.trace('pipe from %s', from.constructor.name);
        });
        this.on('unpipe', function(from) {
            that.log.trace('unpipe from %s', from.constructor.name);
        });
    }

    onFrameFromAGW(frame) {
        this.log.trace('received frame.dataKind %s', frame.dataKind);
        switch(frame.dataKind) {
        case 'C':
            this.emit('connected', frame.data);
            break;
        case 'd': // disconnect
            this.emit('end', frame.data);
            this.destroy();
            break;
        case 'D': // data
            if (this.isClosed) {
                this.emit('error', newError('received data after close '
                                            + getDataSummary(frame.data)));
            } else if (!this._pushable) {
                this.emit('error', newError('receive buffer overflow: '
                                            + getDataSummary(frame.data)));
            } else {
                if (this.log.trace()) {
                    this.log.trace(`push ${frame.data}`);
                }
                this._pushable = this.push(frame.data);
            }
            break;
        default:
        }
    }

    _read(size) {
        this._pushable = true;
        // onFrameFromAGW calls this.push.
    }

    _write(data, encoding, afterWrite) {
        this.toAGW.write(data, afterWrite);
    }

    _final(callback) {
        this.log.debug('_final(%s)', typeof callback);
        this.toAGW.end(callback);
    }

    _destroy(err, callback) {
        this.log.debug('_destroy(%s, %s)', err || '', typeof callback);
        // The documentation seems to say this.destroy() should emit
        // 'end' and 'close', but I find that doesn't always happen.
        // This works reliably:
        if (!this.isEnded) this.emit('end');
        if (!this.isClosed) this.emit('close');
        if (callback) callback(err);
    }

} // Connection

/** Similar to net.Server, but for AX.25 connections.
    Each 'connection' event provides a Duplex stream
    for exchanging data via one AX.25 connection.
    The remote call sign is connection.remoteAddress.
    To disconnect, call connection.end(). The connection
    emits a 'close' event when AX.25 is disconnected.
*/
class Server extends EventEmitter {

    constructor(options, onConnect) {
        super();
        guts.checkNodeVersion();
        if (!(options && options.port)) {
            throw newError('no options.port', 'ERR_INVALID_ARG_VALUE');
        }
        const that = this;
        this.log = getLogger(options, this);
        this.log.trace('new(%s, %s)', options, typeof onConnect);
        this.options = options;
        this.listening = false;
        this.hosts = [];
        this.fromAGW = new guts.Receiver(options);
        this.onErrorOrTimeout(this.fromAGW);
        this.toAGW = new guts.Sender(options);
        this.portRouter = new PortRouter(this.toAGW, this.fromAGW, options, this);
        this.portRouter.on('registeredCall', function(info) {
            if ((typeof info) != 'string') this.emit('error', info);
        });
        if (onConnect) this.on('connection', onConnect);
    }

    createSocket(options) {
        return new RawSocket(options, this);
    }

    listen(options, callback) {
        this.log.trace('listen(%o, %s)', options, typeof callback);
        if (this.listening) {
            throw newError('Server is already listening.', 'ERR_SERVER_ALREADY_LISTEN');
        }
        if (!options) throw newError('no options', 'ERR_INVALID_ARG_VALUE');
        this.hosts = validateHosts(options.host);
        this.ports = validatePorts(options.port);
        const that = this;
        this._connectToAGW(function connected(err) {
            if (err) {
                that.emit('error', err);
            } else {
                that.listening = true;
                that._connected(options, callback);
            }
        });
    }

    _connectToAGW(callback) {
        if (this.netSocket) {
            callback();
        } else {
            try {
                const that = this;
                const connectOptions = Object.assign({
                    host: '127.0.0.1',
                    port: 8000,
                }, this.options);
                delete connectOptions.logger;
                delete connectOptions.Net;
                this.log.trace('%s.createConnection(%o)',
                               this.options.Net ? 'options.Net' : 'Net',
                               connectOptions);
                const socket = (this.options.Net || Net)
                      .createConnection(connectOptions, function connectionListener(info) {
                          that.log.debug('Connected to TNC (%s)', info || '');
                          socket.pipe(that.fromAGW);
                          that.toAGW.pipe(socket);
                          that.netSocket = socket;
                          that.toAGW.write({dataKind: 'G'}); // Get information about all ports
                          if (callback) callback();
                      });
                this.onErrorOrTimeout(socket);
                socket.on('close', function(err) {
                    that.log.debug('socket emitted close(%s)', err || '');
                    socket.unpipe(that.fromAGW);
                    that.toAGW.unpipe(socket);
                    if (that.netSocket === socket) {
                        that.netSocket = null;
                    }
                });
            } catch(err) {
                if (callback) callback(err);
            }
        }
    }

    _connected(options, callback) {
        const that = this;
        if (!this.ports) {
            // Postpone until we know what ports exist.
            this.listenBuffer = [options, callback];
            return;
        } else if (this.ports.length <= 0) {
            this.emit('error', newError('The TNC has no ports.', 'ENOENT'));
            return;
        }
        this._address = {
            host: flattenArray(this.hosts),
            port: flattenArray(this.ports),
        };
        if (callback) callback(this._address);
        this.emit('listening', this._address);
        this.ports.forEach(function(onePort) {
            that.hosts.forEach(function(oneHost) {
                that.toAGW.write({
                    dataKind: 'X', // Register
                    port: onePort,
                    callFrom: oneHost,
                });
            });
        });
    }

    address() {
        return this._address;
    }

    onErrorOrTimeout(from) {
        const that = this;
        ['error', 'timeout'].forEach(function(event) {
            from.on(event, function(info) {
                that.log.trace('%s emitted %s %s',
                               from.constructor.name, event, info || '');
                that.emit(event, info);
            });
        });
    }

    setPorts(ports) {
        this.log.debug('setPorts %o', ports);
        this.ports = ports;
        if (this.listenBuffer) {
            const options = this.listenBuffer[0];
            const callback = this.listenBuffer[1];
            delete this.listenBuffer;
            this._connected(options, callback);
        }
    }

    close(callback) {
        this.log.trace('close()');
        if (!this.listening) {
            if (callback) callback(newError('Server is already closed'));
        } else {
            if (this.netSocket) {
                this.netSocket.destroy();
                delete this.netSocket;
            }
            this.listening = false;
            delete this._address;
            this.emit('close');
            if (callback) callback();
        }
    }

    createConnection(options, onConnected) {
        guts.checkNodeVersion();
        const log = options.logger || guts.LogNothing;
        log.debug('createConnection(%j, %s)',
                  mergeOptions(options, {logger: null}),
                  typeof callback);
        const localPort = guts.validatePort(options.localPort || 0);
        if (localPort >= this.ports.length) {
            throw guts.newRangeError(`There is no port ${localPort}.`, 'ENOENT');
        }
        const localAddress = guts.validateCallSign('local', options.localAddress);
        const remoteAddress = guts.validateCallSign('remote', options.remoteAddress);
        const via = guts.validatePath(options.via);
        const that = this;
        const portThrottle = this.portRouter.getClientFor({port: localPort});
        const connectionRouter = portThrottle.client;
        const connectionThrottle = connectionRouter.getClientFor({
            port: localPort,
            dataKind: 'sendConnection',
            callTo: localAddress,
            callFrom: remoteAddress,
        });
        if (options.ID) connectionThrottle.ID = options.ID;
        const connection = connectionThrottle.client;
        this.portRouter.on('registeredCall', function(info) {
            if ((typeof info) != 'string') { // Registration failed.
                if (info.address == localAddress) {
                    connection.emit('error', info);
                }
            } else if (info == localAddress && that.hosts.indexOf(localAddress) < 0) {
                that.hosts.push(localAddress);
            }
        });
        connection.on('connected', function(data) {
            connectionThrottle.write(connectionThrottle.queryFramesInFlight());
            onConnected(data);
        });
        if (this.hosts.indexOf(localAddress) < 0) {
            portThrottle.write({
                dataKind: 'X', // Register
                port: localPort,
                callFrom: localAddress,
            });
        }
        connectionThrottle.write(guts.connectFrame(localPort, localAddress, remoteAddress, via));
        return connection;
    } // createConnection

} // Server

exports.Server = Server;

// The following are used by client.js or converse.js:
exports.Connection = Connection;
exports.ConnectionThrottle = ConnectionThrottle;
exports.FrameAssembler = FrameAssembler;
exports.newError = newError;
