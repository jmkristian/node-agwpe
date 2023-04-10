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

When an AX.25 connection is disconnected, the Connection
initiates a sequence of calls to FrameAssembler.end() and
ConnectionThrottle.end(). The sequence is connected by
events: a 'finish' event from Connection and 'end' events
from FrameAssembler and ConnectionThrottle.
*/

const EventEmitter = require('events');
const guts = require('./guts.js');
const Net = require('net');
const process = require('process');
const Stream = require('stream');

const newError = guts.newError;

const HeaderLength = 36;
const DefaultFrameLength = 128;
const NoPID = 0xF0;
const KByte = 1 << 10;

const LogNothing = {
    child: function(){return LogNothing;},
    trace: function(){},
    debug: function(){},
    info: function(){},
    warn: function(){},
    error: function(){},
    fatal: function(){},
};

function checkNodeVersion() {
    const version = process.versions.node;
    const parts = version.split('.').map(s => parseInt(s));
    if (parts[0] < 8 || (parts[0] == 8 && parts[1] < 17)) {
        throw new Error('node-agwpe works with version 8.17.0 or later (not ' + version + ').');
    }
}

function getLogger(options, that) {
    if (!(options && options.logger)) {
        return LogNothing;
    } else if (that) {
        return options.logger.child({'class': that.constructor.name});
    } else {
        return options.logger;
    }
}

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

function hexByte(from) {
    return ((from >> 4) & 0x0F).toString(16) + (from & 0x0F).toString(16)
}

function hexBuffer(buffer) {
    var hex = '';
    for (var f = 0; f < buffer.length; ++f) {
        if (hex) hex += ' ';
        hex += hexByte(buffer[f]);
    }
    return hex;
}

function getDataSummary(data) {
    if (data.length <= 32) {
        return data.toString('binary').replace(/\r/g, '\\r');
    } else {
        return data.toString('binary', 0, 32).replace(/\r/g, '\\r') + '...';
    }
}

function getFrameSummary(frame) {
    var summary = {};
    Object.assign(summary, frame);
    if (frame.data == null) {
        delete summary.data;
        delete summary.dataLen;
    } else if (frame.dataKind == 'S') {
        summary.data = frame.data.toString('binary');
        delete summary.dataLen;
    } else if (frame.data.length <= 32) {
        switch(frame.dataKind) {
        case 'g':
        case 'K':
        case 'R':
        case 'X':
        case 'Y':
        case 'y':
            summary.data = hexBuffer(frame.data);
            break;
        default:
            summary.data = getDataSummary(frame.data);
        }
        delete summary.dataLen;
    } else {
        summary.data = getDataSummary(frame.data);
        summary.dataLen = frame.data.length;
    }
    if (summary.user == 0) delete summary.user;
    if (summary.callTo == '') delete summary.callTo;
    if (summary.callFrom == '') delete summary.callFrom;
    return JSON.stringify(summary);
}

function mergeOptions(from) {
    var args = Array.from(arguments);
    var into = {};
    args.splice(0, 0, into);
    Object.assign.apply(Object, args);
    return into;
}

function getASCII(frame, offset) {
    var into = '';
    for (var i = offset; frame[i]; ++i) {
        into = into + String.fromCharCode(frame[i]);
    }
    return into;
}

function copyBuffer(from, start, end) {
    if (start == null) start = 0;
    if (end == null || end > from.length) end = from.length;
    var into = Buffer.alloc(end - start);
    from.copy(into, 0, start, end);
    return into;
}

/** Convert an object to a binary AGWPE frame. */
function toFrame(from, encoding) {
    var data = from.data;
    var dataLength = 0;
    if (data) {
        if ((typeof data) == 'string') {
            data = Buffer.from(data || '', encoding || 'utf-8');
        } else if (!Buffer.isBuffer(data)) {
            if ((typeof data) == 'object') {
                throw newError('data ' + JSON.stringify(data),
                               'ERR_INVALID_ARG_TYPE');
            } else {
                throw newError('data is a ' + (typeof data) + ' (not a string or Buffer).',
                               'ERR_INVALID_ARG_TYPE');
            }
        }
        dataLength = data.length;
    }
    var frame = Buffer.alloc(HeaderLength + dataLength);
    frame.fill(0, 0, HeaderLength);
    frame[0] = from.port || 0;
    frame[4] = from.dataKind ? from.dataKind.charCodeAt(0) : 0;
    frame[6] = (from.PID != null) ? from.PID : NoPID;
    frame.write(from.callFrom || '', 8, 'ascii');
    frame.write(from.callTo || '', 18, 'ascii');
    frame.writeUInt32LE(dataLength, 28);
    frame.writeUInt32LE(from.user || 0, 32);
    if (dataLength) {
        data.copy(frame, HeaderLength);
    }
    return frame;
}

/** Convert a binary AGWPE frame header to an object. */
function fromHeader(buffer) {
    if (buffer.length < HeaderLength) {
        throw `buffer.length ${buffer.length} is shorter than a header`;
    }
    var into = {
        port: buffer[0],
        dataKind: buffer.toString('binary', 4, 5),
        PID: buffer[6],
        callFrom: getASCII(buffer, 8),
        callTo: getASCII(buffer, 18),
        user: buffer.readUInt32LE(32),
    };
    return into;
}

class FramesTo extends Stream.Transform {
    constructor(target) {
        super ({
            readableObjectMode: true,
            writableObjectMode: true,
        });
        this.target = target;
    }
    _transform(chunk, encoding, callback) {
        try {
            this.target.write(chunk, encoding, callback);
        } catch(err) {
            if (callback) callback(err);
        }
    }
    _flush(callback) {
        if (callback) callback();
        // But don't molest the target.
    }
}

const EmptyBuffer = Buffer.alloc(0);

/** Transform binary AGWPE frames to objects. */
class Receiver extends Stream.Writable {

    constructor(options) {
        super({
            objectMode: false,
            highWaterMark: HeaderLength +
                ((options && options.frameLength) || DefaultFrameLength), // bytes
        });
        this.log = getLogger(options, this);
        this.log.trace('new(%s)', options);
        this.header = Buffer.alloc(HeaderLength);
        this.headerLength = 0;
        const that = this;
        this.on('pipe', function(from) {
            that.log.trace('pipe from %s', from.constructor.name);
        });
        this.on('unpipe', function(from) {
            that.log.trace('unpipe from %s', from.constructor.name);
        });
    }

    _write(chunk, encoding, afterTransform) {
        try {
            this.log.trace('_write %d', chunk.length);
            if (encoding != 'buffer') {
                throw newError(`Receiver._write encoding ${encoding}`, 'ERR_INVALID_ARG_VALUE');
            }
            if (!Buffer.isBuffer(chunk)) {
                throw newError(`Receiver._write chunk isn't a Buffer`, 'ERR_INVALID_ARG_TYPE');
            }
            if (this.data) {
                // We have part of the data. Append the new chunk to it.
                var newBuffer = Buffer.alloc(this.data.length + chunk.length);
                this.data.copy(newBuffer, 0);
                chunk.copy(newBuffer, this.data.length);
                this.data = newBuffer;
            } else {
                // Start a new frame.
                var headerSlice = Math.min(HeaderLength - this.headerLength, chunk.length);
                if (headerSlice > 0) {
                    chunk.copy(this.header, this.headerLength, 0, headerSlice);
                    this.headerLength += headerSlice;
                }
                if (headerSlice < chunk.length) {
                    this.data = copyBuffer(chunk, headerSlice);
                }
            }
            while(true) {
                if (this.headerLength < HeaderLength) {
                    this.log.trace('wait for header');
                    break;
                }
                var dataLength = this.header.readUInt32LE(28);
                var bufferLength = this.data ? this.data.length : 0;
                if (bufferLength < dataLength) {
                    this.log.trace('wait for data');
                    break;
                }
                // Construct a result:
                var result = fromHeader(this.header);
                result.data = (dataLength <= 0) ? EmptyBuffer
                    : (dataLength == this.data.length)
                    ? this.data
                    : copyBuffer(this.data, 0, dataLength);
                // Shift the remaining data into this.header and this.data:
                this.headerLength = Math.min(HeaderLength, bufferLength - dataLength);
                if (this.headerLength > 0) {
                    this.data.copy(this.header, 0, dataLength, dataLength + this.headerLength);
                }
                var newBufferLength = bufferLength - (dataLength + this.headerLength);
                this.data = (newBufferLength <= 0) ? null
                    : copyBuffer(this.data, dataLength + this.headerLength);
                if (this.log.debug()) {
                    this.log.debug('< %s', getFrameSummary(result));
                }
                this.emitFrameFromAGW(result);
            }
            afterTransform();
        } catch(err) {
            this.emit('error', err);
            afterTransform(err);
        }
    } // _write

    _final(callback) {
        this.log.trace('_final');
        if (callback) callback();
    }
} // Receiver

/** Transform objects to binary AGWPE frames. */
class Sender extends Stream.Transform {

    constructor(options) {
        super({
            readableObjectMode: false,
            readableHighWaterMark: HeaderLength +
                ((options && options.frameLength) || DefaultFrameLength), // bytes
            writableObjectMode: true,
            writableHighWaterMark: 1, // frame
            defaultEncoding: options && options.encoding,
        });
        this.log = getLogger(options, this);
        const that = this;
        this.on('pipe', function(from) {
            that.log.trace('pipe from %s', from.constructor.name);
        });
        this.on('unpipe', function(from) {
            that.log.trace('unpipe from %s', from.constructor.name);
        });
    }

    _transform(chunk, encoding, afterTransform) {
        if ((typeof chunk) != 'object') {
            this.log.debug('_transform(%j, %s, %s)', chunk, encoding, afteTransform);
            if (afterTransform) afterTransform(newError(`Sender ${chunk}`, 'ERR_INVALID_ARG_TYPE'));
        } else {
            try {
                var frame = toFrame(chunk, encoding);
                if (this.log.debug()) {
                    this.log.debug('> %s', getFrameSummary(chunk));
                }
                this.push(frame);
                if (afterTransform) afterTransform();
            } catch(err) {
                this.log.debug(err);
                if (afterTransform) afterTransform(err);
            }
        }
    }

    _flush(callback) {
        this.log.trace('_flush');
        if (callback) callback();
    }
} // Sender

/** Creates a client object to handle each connection to an AGW port
    or a remote AX.25 station. Also, passes frames received via each
    connection to the client that handles that connection.
*/
class Router extends EventEmitter {

    constructor(toAGW, fromAGW, options, server) {
        super();
        this.log = getLogger(options, this);
        this.log.trace('new %s', options);
        this.toAGW = toAGW;
        this.fromAGW = fromAGW;
        this.options = options;
        this.server = server;
        this.clients = {};
        const that = this;
        ['error', 'timeout'].forEach(function(event) {
            fromAGW.on(event, function(info) {
                for (const c in that.clients) {
                    that.clients[c].emit(event, info);
                }
            });
        });
        const fromAGWClass = fromAGW.constructor.name;
        fromAGW.on('close', function onClose() {
            that.log.trace('closed %s; destroy clients', fromAGWClass);
            for (const c in that.clients) {
                that.clients[c].destroy();
            }
            that.emit('close');
        });
        this.log.trace('set %s.emitFrameFromAGW', fromAGW.constructor.name);
        fromAGW.emitFrameFromAGW = function(frame) {
            var key = that.getKey(frame);
            var client = that.clients[key];
            if (!client) {
                client = that.newClient(frame);
                if (client) {
                    that.clients[key] = client;
                    const clientClass = client.constructor.name;
                    client.on('close', function() {
                        that.log.trace('closed %s; delete client', clientClass);
                        delete that.clients[key];
                    });
                    client.on('finish', function() {
                        that.log.trace('finished %s', clientClass);
                    });
                }
            }
            try {
                that.log.trace('route %s frame to %s',
                               frame.dataKind, client && client.constructor.name);
                that.onFrameFromAGW(frame, client);
            } catch(err) {
                that.emit('error', err);
            }
        };
    }
} // Router

/** Manages objects that handle data to and from each AGW port. */
class PortRouter extends Router {

    constructor(toAGW, fromAGW, options, server) {
        super(toAGW, fromAGW, options, server);
    }

    getKey(frame) {
        return frame.port;
    }

    newClient(frame) {
        var throttle = new PortThrottle(this.options, frame);
        var router = new ConnectionRouter(throttle, throttle, this.options, this.server);
        throttle.pipe(this.toAGW);
        throttle.write(throttle.queryFramesInFlight());
        // The response will initialize throttle.inFlight.
        return throttle;
    }

    onFrameFromAGW(frame, client) {
        this.log.debug('onFrameFromAGW %s', getFrameSummary(frame));
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
            if (!(frame.data && frame.data.length > 0 && frame.data[0] == 1)) {
                this.server.emit('error', newError('listen failed: ' + getFrameSummary(frame), 'ENOENT'));
            }
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
        if (frame.dataKind == 'Y') {
            return `${frame.port} ${frame.callTo} ${frame.callFrom}`;
        } else {
            return `${frame.port} ${frame.callFrom} ${frame.callTo}`;
        }
    }

    newClient(frame) {
        if (frame.dataKind != 'C') { // connect
            return null;
        }
        var throttle = new ConnectionThrottle(this.options, frame);
        throttle.pipe(new FramesTo(this.toAGW));
        throttle.write(throttle.queryFramesInFlight());
        var dataToFrames = new FrameAssembler(this.options, frame);
        dataToFrames.pipe(throttle);
        var connection = new Connection(dataToFrames, this.options);
        var connectionClass = connection.constructor.name;
        var dataToFramesClass = dataToFrames.constructor.name;
        var throttleClass = throttle.constructor.name;
        var that = this;
        // The pipeline of streams from connection to throttle
        // is ended by relaying the 'end' events.
        connection.on('finish', function(info) {
            that.log.trace('%s emitted finish; %s.end', connectionClass, dataToFramesClass);
            dataToFrames.end();
        });
        dataToFrames.on('end', function(info) {
            that.log.trace('%s emitted end(%s); %s.end',
                           dataToFramesClass, info || '', throttleClass);
            throttle.end();
        });
        // The connection is destroyed after the throttle closes;
        // that is, after data is flushed to the port and any
        // expected response is received.
        throttle.on('close', function(info) {
            that.log.trace('%s emitted close(%j); %s.destroy()',
                           throttleClass, info || '', connectionClass);
            connection.destroy();
        });
        ['error', 'timeout'].forEach(function(event) {
            throttle.on(event, function(info) {
                that.log.trace('%s emitted %s; %s.emit %s',
                               throttleClass, event, connectionClass, event);
                connection.emit(event, info);
            });
        });
        this.log.trace('set %s.emitFrameFromAGW', throttle.constructor.name);
        throttle.emitFrameFromAGW = function onFrameFromAGW(frame) {
            connection.onFrameFromAGW(frame); 
        };
        this.server.emit('connection', connection);
        return throttle;
    }

    onFrameFromAGW(frame, client) {
        if (client) {
            client.onFrameFromAGW(frame);
            // Disconnect frames are handled by the client.
        }
    }
} // ConnectionRouter

const MaxFramesInFlight = 8;

/** Delay transmission of frames, to avoid overwhelming AGWPE.
    The frames aren't changed, merely delayed.
*/
class Throttle extends Stream.Transform {

    constructor(options) {
        super({
            readableObjectMode: true,
            readableHighWaterMark: 1,
            // The readableHighWaterMark is small to help maintain an accurate
            // value of this.inFlight.  We don't want to receive an update and
            // set inFlight = 0 when in fact there are multiple frames in the
            // transform output buffer, soon to be sent.
            writableObjectMode: true,
            writableHighWaterMark: 5,
        });
        this.log = getLogger(options, this);
        this.log.trace('new %j', Object.assign({}, options, {logger: null}));
        this.buffer = [];
        this.inFlight = 0;
        this.maxInFlight = MaxFramesInFlight;
        const that = this;
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
        this.pushBuffer();
    }

    pushBuffer() {
        this.log.trace('pushBuffer %d', this.buffer.length);
        const that = this;
        while (this.buffer.length > 0) {
            if ((typeof this.buffer[0]) == 'function') {
                // Call a callback:
                this.buffer.shift()();
            } else if (this.inFlight < this.maxInFlight) {
                // Push a frame:
                this.pushFrame(this.buffer.shift());
                this.stopPolling();
            } else {
                // Wait until inFlight decreases.
                if (!this.polling) {
                    this.log.trace('start polling');
                    this.polling = setInterval(function() {
                        that.pushFrame(that.queryFramesInFlight());
                    }, 2000);
                }
                break;
            }
        }
    }

    pushFrame(frame) {
        if (frame != null) {
            switch(frame.dataKind) {
            case 'D': // connected data
            case 'K': // raw AX.25 data
            case 'M': // UNPROTO data
            case 'V': // UNPROTO VIA
                ++this.inFlight;
                if (this.inFlight == this.maxInFlight / 2) {
                    // Look ahead, to possibly avoid polling later:
                    this.log.trace('query framesInFlight');
                    this.push(this.queryFramesInFlight());
                }
                break;
            default:
                // non-data frames don't count
            }
            if (this.log.trace()) {
                this.log.trace(`push %s`, getFrameSummary(frame));
            }
            this.push(frame);
        }
    }

    stopPolling() {
        if (this.polling) {
            this.log.trace('stop polling');
            clearInterval(this.polling);
            this.polling = null;
        }
    }

    _transform(frame, encoding, callback) {
        this.log.trace('_transform');
        this.buffer.push(frame);
        if (callback) this.buffer.push(callback);
        this.pushBuffer();
    }

    _flush(callback) {
        this.log.trace('_flush');
        const that = this;
        if (this.bufferFinalFrames) {
            this.bufferFinalFrames();
        }
        this.buffer.push(function() {
            that.log.trace('after _flush');
            that.stopPolling();
            if (callback) callback();
            that.emit('end'); // in case Stream.Transform doesn't do it.
        });
        this.pushBuffer();
    }

    _destroy(err, callback) {
        this.log.trace('_destroy(%s)', err || '');
        if (callback) callback(err);
    }
} // Throttle

/* Limit the rate of frames to an AGW port. */
class PortThrottle extends Throttle {

    constructor(options, frame) {
        super(options);
        this.port = frame.port;
        // Each connection adds listeners to this.
        // The number of possible connections is very large, so:
        this.setMaxListeners(0); // unlimited
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
            this.emitFrameFromAGW(frame);
        }
    }
} // PortThrottle

/* Limit the rate of frames to an AX.25 connection. */
class ConnectionThrottle extends Throttle {

    constructor(options, frame) {
        super(options);
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
            this.emitFrameFromAGW(frame);
            if (this._disconnected) { // we disconnected
                // _flush has already pushed disconnect and this.ID.
                this.destroy();
                this.emit('close');
            } else { // the remote station disconnected
                this._disconnected = true;
                this.end( // push this.ID, and then:
                    null, null, function() {
                        that.destroy();
                        that.emit('close');
                    });
            }
            break;
        default:
            this.emitFrameFromAGW(frame);
        }
    }

    bufferFinalFrames() {
        const that = this;
        if (!this._disconnected) {
            this.log.debug('send disconnect');
            // Wait until there are no more frames in flight
            // (so they won't be obliterated by disconnecting).
            this.buffer.push(function() {
                that.maxInFlight = 1;
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
                that._disconnected = true;
            });
        }
        if (this.ID) {
            this.log.debug('send ID');
            this.buffer.push({
                dataKind: 'M', // UNPROTO
                port: this.port,
                callTo: 'ID',
                callFrom: this.myCall,
                data: Buffer.from(this.ID + '', 'latin1'),
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
        this.log.trace('new %s', options);
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
                        that.pushBuffer();
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
                this.pushBuffer(); // stops the timeout
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
                            that.pushBuffer();
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

    _flush(afterFlush) {
        this.log.trace(`_flush`);
        this.pushBuffer();
        afterFlush();
    }

    pushBuffer() {
        if (this.timeout != null) {
            clearTimeout(this.timeout);
            this.timeout = null;
        }
        if (this.bufferCount > 0) {
            var data = this.buffer.subarray(0, this.bufferCount);
            // The callback might ultimately call this._transform,
            // which might add more data into this.buffer or call
            // this.pushBuffer again. To prevent confusion:
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

    constructor(toAGW, options) {
        super({
            allowHalfOpen: true,
            emitClose: false, // emitClose: true doesn't always emit close.
            readableObjectMode: false,
            readableHighWaterMark: 4 * KByte,
            writableObjectMode: false,
            writableHighWaterMark: 2 * ((options && options.frameLength) || DefaultFrameLength),
        });
        this.log = getLogger(options, this);
        this.log.trace('new %s', options);
        this.ID = options.ID;
        this.toAGW = toAGW;
        this.port = toAGW.port;
        this.localAddress = toAGW.myCall;
        this.remoteAddress = toAGW.theirCall;
        this._pushable = false;
        this._closed = false;
        const that = this;
        this.on('pipe', function(from) {
            that.log.trace('pipe from %s', from.constructor.name);
        });
        this.on('unpipe', function(from) {
            that.log.trace('unpipe from %s', from.constructor.name);
        });
    }

    onFrameFromAGW(frame) {
        this.log.trace('received %s frame', frame.dataKind);
        switch(frame.dataKind) {
        case 'd': // disconnect
            this.emit('end', frame.data);
            this._ended = true;
            // this.destroy(); not until the ConnectionThrottle emits 'close'
            break;
        case 'D': // data
            if (this._closed) {
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
        this.log.trace('_final');
        if (!this._finished) {
            this._finished = true;
            this.emit('finish');
        }
        if (callback) callback();
    }

    _destroy(err, callback) {
        this.log.trace('_destroy(%s)', err || '');
        // The documentation seems to say this.destroy() should emit
        // 'end' and 'close', but I find that doesn't always happen.
        // This works reliably:
        this._final(); // in case it hasn't already been called.
        if (!this._ended) {
            this._ended = true;
            this.emit('end');
        }
        if (!this._closed) {
            this._closed = true;
            this.emit('close');
        }
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
        checkNodeVersion();
        if (!(options && options.port)) {
            throw newError('no options.port', 'ERR_INVALID_ARG_VALUE');
        }
        const that = this;
        this.log = getLogger(options, this);
        this.log.trace('new(%s, %s)', options, typeof onConnect);
        this.options = options;
        this.listening = false;
        this.fromAGW = new Receiver(options);
        this.onErrorOrTimeout(this.fromAGW);
        this.toAGW = new Sender(options);
        new PortRouter(this.toAGW, this.fromAGW, options, this);
        if (onConnect) this.on('connection', onConnect);
    }

    listen(options, callback) {
        this.log.trace('listen(%o, %s)', options, typeof callback);
        if (!options) throw newError('no options', 'ERR_INVALID_ARG_VALUE');
        this.hosts = validateHosts(options.host);
        this.ports = validatePorts(options.port);
        if (this.listening) {
            throw newError('Server is already listening.', 'ERR_SERVER_ALREADY_LISTEN');
        }
        this.listening = true;
        try {
            const that = this;
            const connectOptions = Object.assign({host: '127.0.0.1'}, this.options);
            delete connectOptions.logger;
            delete connectOptions.Net;
            this.log.trace('%s.createConnection(%o)',
                           this.options.Net ? 'options.Net' : 'Net',
                           connectOptions);
            const socket = (this.options.Net || Net)
                  .createConnection(connectOptions, function connectionListener(err) {
                      that.log.trace('connectionListener(%s)', err);
                      socket.pipe(that.fromAGW);
                      that.toAGW.pipe(socket);
                      that.socket = socket;
                      that.toAGW.write({dataKind: 'G'}); // Get information about all ports
                      that._connected(options, callback);
                  });
            this.onErrorOrTimeout(socket);
            socket.on('close', function(err) {
                that.log.trace('socket emitted close(%s)', err || '');
                socket.unpipe(that.fromAGW);
                that.toAGW.unpipe(that.socket);
            });
        } catch(err) {
            this.emit('error', err);
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
            if (this.socket) {
                this.socket.destroy();
                delete this.socket;
            }
            this.listening = false;
            delete this._address;
            this.emit('close');
            if (callback) callback();
        }
    }
} // Server

exports.Sender = Sender;
exports.Receiver = Receiver;
exports.Server = Server;

// The following are used for testing, only.
exports.fromHeader = fromHeader;
exports.getDataSummary = getDataSummary;
exports.toFrame = toFrame;
exports.HeaderLength = HeaderLength;

// The following are used by client.js or converse.js:
exports.Connection = Connection;
exports.ConnectionThrottle = ConnectionThrottle;
exports.checkNodeVersion = checkNodeVersion;
exports.FrameAssembler = FrameAssembler;
exports.FramesTo = FramesTo;
exports.LogNothing = LogNothing;
exports.newError = newError;
