/** Utilities for exchanging data via AGWPE and AX.25. */
/*
Received data pass through a chain of function calls;
transmitted data flow through a pipeline of Transform
streams, like this:

        Net.Socket
     ----------------
       |         ^
       v         |
   AGWReader AGWWriter
       |         ^
       v         |
  PortRouter     |
          |      |
          v      |
        PortThrottle
          |      ^
          v      |
ConnectionRouter |
          |      |
          v      |
      ConnectionThrottle
            |    ^
            |    |
            |  DataToFrames
            |    ^
            v    |
          Connection

When an AX.25 connection is disconnected, the Connection
initiates a sequence of calls to DataToFrames.end() and
ConnectionThrottle.end(). The sequence is connected by
events: a 'finish' event from Connection and 'end' events
from DataToFrames and ConnectionThrottle.
*/

const EventEmitter = require('events');
const Net = require('net');
const Stream = require('stream');

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

function newError(message, code) {
    const err = new Error(message);
    if (code) err.code = code;
    return err;
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
            throw 'data is neither a string nor a buffer';
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

const EmptyBuffer = Buffer.alloc(0);

/** Transform binary AGWPE frames to objects. */
class AGWReader extends Stream.Writable {

    constructor(options) {
        super({
            readableObjectMode: true,
            readableHighWaterMark: 1, // frame
            writableObjectMode: false,
            writableHighWaterMark: HeaderLength +
                (options.frameLength || DefaultFrameLength), // bytes
        });
        this.log = getLogger(options, this);
        this.log.trace('new(%o)', options);
        this.header = Buffer.alloc(HeaderLength);
        this.headerLength = 0;
        this.on('pipe', function(from) {
            this.log.debug('pipe from %s', from.constructor.name);
        });
        this.on('unpipe', function(from) {
            this.log.debug('unpipe from %s', from.constructor.name);
        });
    }

    _write(chunk, encoding, afterTransform) {
        try {
            this.log.trace('_write %d', chunk.length);
            if (encoding != 'buffer') {
                throw newError(`AGWReader._write encoding ${encoding}`, 'ERR_INVALID_ARG_VALUE');
            }
            if (!Buffer.isBuffer(chunk)) {
                throw newError(`AGWReader._write chunk isn't a Buffer`, 'ERR_INVALID_ARG_TYPE');
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
} // AGWReader

/** Transform objects to binary AGWPE frames. */
class AGWWriter extends Stream.Transform {

    constructor(options) {
        super({
            readableObjectMode: false,
            readableHighWaterMark: HeaderLength +
                (options.frameLength || DefaultFrameLength), // bytes
            writableObjectMode: true,
            writableHighWaterMark: 1, // frame
            defaultEncoding: options && options.encoding,
        });
        this.log = getLogger(options, this);
    }

    _transform(chunk, encoding, afterTransform) {
        if ((typeof chunk) != 'object') {
            afterTransform(`AGWWriter ${chunk}`);
        } else {
            var frame = toFrame(chunk, encoding);
            if (this.log.debug()) {
                this.log.debug('> %s', getFrameSummary(chunk));
            }
            afterTransform(null, frame);
        }
    }
} // AGWWriter

/** Creates a client object to handle each connection to an AGW port
    or a remote AX.25 station. Also, passes frames received via each
    connection to the client that handles that connection.
*/
class Router extends EventEmitter {

    constructor(toAGW, fromAGW, options, server) {
        super();
        this.log = getLogger(options, this);
        this.log.trace('new %o', options);
        this.toAGW = toAGW;
        this.fromAGW = fromAGW;
        this.options = options;
        this.server = server;
        this.clients = {};
        var that = this;
        ['error', 'timeout'].forEach(function(event) {
            fromAGW.on(event, function(info) {
                for (const c in that.clients) {
                    that.clients[c].emit(event, info);
                }
            });
        });
        var fromAGWClass = fromAGW.constructor.name;
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
                    var clientClass = client.constructor.name;
                    client.on('end', function() {
                        that.log.trace('ended %s; delete client', clientClass);
                        delete that.clients[key];
                    });
                    if (that.log.trace()) {
                        client.on('finish', function() {
                            that.log.trace('finished %s', clientClass);
                        });
                    }
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
        var throttle = new PortThrottle(this.toAGW, this.options, frame);
        var router = new ConnectionRouter(throttle, throttle, this.options, this.server);
        return throttle;
    }

    onFrameFromAGW(frame, client) {
        this.log.debug('onFrameFromAGW %s', getFrameSummary(frame));
        const that = this;
        switch(frame.dataKind) {
        case 'G': // available ports
            try {
                var parts = frame.data.toString('ascii').split(';');
                var ports = [];
                for (var p = 1; p < parts.length; ++p) {
                    var found = (/^port(\d+)/i).exec(parts[p]);
                    if (found) {
                        ports.push(parseInt(found[1]));
                    }
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
        var throttle = new ConnectionThrottle(this.toAGW, this.options, frame);
        var dataToFrames = new DataToFrames(this.options, frame);
        dataToFrames.pipe(throttle);
        var connection = new Connection(dataToFrames, this.options);
        var connectionClass = connection.constructor.name;
        var dataToFramesClass = dataToFrames.constructor.name;
        var throttleClass = throttle.constructor.name;
        var that = this;
        // The pipeline of streams from connecton to throttle
        // is ended by relaying the 'end' events.
        connection.on('finish', function(info) {
            that.log.trace('finished %s; %s.end', connectionClass, dataToFramesClass);
            dataToFrames.end();
        });
        dataToFrames.on('end', function(info) {
            that.log.trace('ended %s; %s.end', dataToFramesClass, throttleClass);
            throttle.end();
        });
        // The connection emits close after the throttle ends;
        // that is, after data is flushed to the port.
        throttle.on('end', function(info) {
            that.log.trace('ended %s; %s.emitClose',
                           throttleClass, connectionClass);
            connection.emitClose();
        });
        ['error', 'timeout'].forEach(function(event) {
            throttle.on(event, function(info) {
                that.log.trace('%sed %s; %s.emit %s',
                               event, throttleClass, connectionClass, event);
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

    constructor(toAGW, options) {
        super({
            readableObjectMode: true,
            readableHighWaterMark: 1,
            writableObjectMode: true,
            writableHighWaterMark: 1,
        });
        this.log = getLogger(options, this);
        this.log.trace('new %o', options);
        this.toAGW = toAGW;
        this.inFlight = 0;
        this.maxInFlight = MaxFramesInFlight;
        this.pipe(this.toAGW);
        this.pushFrame(this.queryFramesInFlight());
        // The response will initialize this.inFlight.
    }

    updateFramesInFlight(frame) {
        this.inFlight = frame.data.readUInt32LE(0);
        this.log.trace('inFlight = %d', this.inFlight);
        this.pushBuffer();
    }

    pushBuffer() {
        if (!this.buffer) {
            if (!this.afterFlushed) {
                return;
            } else { // flushing is in progress
                var nextFrame = this.lastFrame
                    ? null // this.lastFrame has already been pushed.
                    : (this.createLastFrame && this.createLastFrame());
                if (nextFrame) {
                    // If you send a disconnect frame immediately,
                    // the previous data won't be transmitted.
                    // So wait until inFlight == 0 to send nextFrame.
                    this.log.trace('lastFrame = %j', nextFrame);
                    this.lastFrame = nextFrame;
                    this.buffer = {frame: nextFrame, afterPush: this.afterFlushed};
                    this.maxInFlight = 1;
                    this.afterFlushed = null;
                } else { // flushing is complete
                    this.afterFlushed();
                    this.afterFlushed = null;
                    return;
                }
            }
        }
        // There is a buffer. Can we push it?
        if (this.inFlight >= this.maxInFlight) {
            if (!this.polling) {
                this.log.trace('start polling');
                this.polling = setInterval(function(that) {
                    that.pushFrame(that.queryFramesInFlight());
                }, 2000, this);
            }
        } else {
            var nextBuffer = this.buffer;
            this.buffer = null;
            this.pushFrame(nextBuffer.frame, nextBuffer.afterPush);
            ++this.inFlight;
            if (this.inFlight < this.maxInFlight) {
                this.stopPolling();
            }
        }
    }

    pushFrame(frame, afterPush) {
        if (frame != null) {
            if (this.log.trace()) {
                this.log.trace(`pushFrame %s`, getFrameSummary(frame));
            }
            this.push(frame);
        }
        if (afterPush != null) {
            afterPush();
        }
    }

    stopPolling() {
        if (this.polling) {
            this.log.trace('stop polling');
            clearInterval(this.polling);
            this.polling = null;
        }
    }

    _transform(frame, encoding, afterTransform) {
        if (this.inFlight >= MaxFramesInFlight) {
            // Don't send it now.
            if (this.buffer) {
                var err = newError('already have a buffer');
                this.log.debug(err);
                this.emit('error', err);
                throw err;
            }
            this.buffer = {frame: frame, afterPush: afterTransform};
            if (this.log.trace()) {
                this.log.trace('postponed %s', getFrameSummary(frame));
            }
            this.pushBuffer();
        } else {
            this.pushFrame(frame, afterTransform);
            ++this.inFlight;
            if (this.inFlight < this.maxInFlight) {
                this.stopPolling();
                if (this.inFlight > 0 && (this.inFlight == this.maxInFlight / 2)) {
                    // Look ahead, to possibly avoid polling later:
                    this.pushFrame(this.queryFramesInFlight());
                }
            }
        }
    }

    _flush(afterFlushed) {
        this.log.trace('_flush');
        var that = this;
        this.afterFlushed = function destructor(err, data) {
            that.log.trace('afterFlushed; unpipe %s',
                           that.toAGW.constructor.name);
            that.stopPolling();
            afterFlushed(err, data);
            that.unpipe(that.toAGW);
            that.emit('end');
        }
        this.pushBuffer();
    }
} // Throttle

/* Limit the rate of frames to an AGW port. */
class PortThrottle extends Throttle {

    constructor(toAGW, options, frame) {
        super(toAGW, options);
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
}

/* Limit the rate of frames to an AX.25 connection. */
class ConnectionThrottle extends Throttle {

    constructor(toAGW, options, frame) {
        super(toAGW, options);
        this.port = frame.port;
        this.myCall = frame.callTo;
        this.theirCall = frame.callFrom;
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
        switch(frame.dataKind) {
        case 'Y': // frames waiting to be transmitted
            this.updateFramesInFlight(frame);
            break;
        case 'd': // disconnected
            this.log.trace('received d frame');
            this.receivedDisconnect = true;
            this.emitFrameFromAGW(frame);
            break;
        default:
            this.emitFrameFromAGW(frame);
        }
    }

    createLastFrame() {
        return this.receivedDisconnect ? null : {
            dataKind: 'd', // disconnect
            port: this.port,
            callFrom: this.myCall,
            callTo: this.theirCall,
        };
    }
} // ConnectionThrottle

const MaxWriteDelay = 250; // msec

/** Transform a stream of data to a stream of AGW frames.
    To promote efficient transmission, data may be delayed for as long as
    MaxWriteDelay, while several chunks are combined into one AGW data frame,
    perhaps as long as options.frameLength.
*/
class DataToFrames extends Stream.Transform {

    constructor(options, frame) {
        super({
            allowHalfOpen: false,
            emitClose: false,
            readableObjectMode: true,
            readableHighWaterMark: 1,
            writableObjectMode: false,
            writableHighWaterMark: options.frameLength || DefaultFrameLength,
        });
        this.log = getLogger(options, this);
        this.log.trace('new %o', options);
        this.port = frame.port;
        this.myCall = frame.callTo;
        this.theirCall = frame.callFrom;
        this.maxDataLength = options.frameLength || DefaultFrameLength;
        this.bufferCount = 0;
    }

    _transform(data, encoding, afterTransform) {
        try {
            if (!Buffer.isBuffer(data)) {
                afterTransform(newError(`DataToFrames._transform ${typeof data}`,
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
                this.log.trace('pushFrame %s', getFrameSummary(frame));
            }
            this.push(frame);
        }
    }
} // DataToFrames

/** Exchanges bytes between one local call sign and one remote call sign. */
class Connection extends Stream.Duplex {

    constructor(toAGW, options) {
        super({
            allowHalfOpen: true,
            emitClose: false, // emitClose: true doesn't always emit close.
            readableObjectMode: false,
            readableHighWaterMark: 4 * KByte,
            writableObjectMode: false,
            writableHighWaterMark: options.frameLength || DefaultFrameLength,
        });
        this.log = getLogger(options, this);
        this.log.trace('new %o', options);
        this.toAGW = toAGW;
        this.port = toAGW.port;
        this.localAddress = toAGW.myCall;
        this.remoteAddress = toAGW.theirCall;
        this.iAmClosed = true;
    }

    emitClose() {
        // The documentation seems to say this.destroy() should emit
        // 'end' and 'close', but I find that doesn't always happen.
        // This works reliably:
        if (!this.iAmClosed) {
            this.iAmClosed = true;
            this.emit('end');
            this.emit('close');
        }
    }

    onFrameFromAGW(frame) {
        this.log.trace('received %s frame', frame.dataKind);
        switch(frame.dataKind) {
        case 'D': // data
            if (!this.iAmClosed) {
                if (!this.receiveBufferIsFull) {
                    this.receiveBufferIsFull = !this.push(frame.data);
                } else {
                    this.emit('error', newError('receive buffer overflow: '
                                                + getDataSummary(frame.data)));
                }
            }
            break;
        case 'd': // disconnect
            this.end();
            break;
        default:
        }
    }

    _read(size) {
        this.receiveBufferIsFull = false;
        // onFrameFromAGW calls this.push.
    }

    _write(data, encoding, afterWrite) {
        this.toAGW.write(data, afterWrite);
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
        if (!(options && options.port)) {
            throw newError('no options.port', 'ERR_INVALID_ARG_VALUE');
        }
        const that = this;
        this.log = getLogger(options, this);
        this.log.debug('new(%o, %s)', options, typeof onConnect);
        this.options = options;
        this.listening = false;
        this.fromAGW = new AGWReader(options);
        this.onErrorOrTimeout(this.fromAGW);
        this.toAGW = new AGWWriter(options);
        new PortRouter(this.toAGW, this.fromAGW, options, this);
        if (onConnect) this.on('connection', onConnect);
    }

    listen(options, callback) {
        this.log.trace('listen(%o)', options);
        if (!(options && options.host && (!Array.isArray(options.host) || options.host.length > 0))) {
            throw newError('no options.host');
        }
        if (options && options.port) {
            var ports = options.port;
            (Array.isArray(ports) ? ports : [ports]).forEach(function(port) {
                if (port < 0 || port > 255) {
                    throw newError(`port ${port} is outside the range 0..255`,
                                   'ERR_INVALID_ARG_VALUE');
                }
            });
        }
        if (this.listening) {
            throw newError('Server is already listening.', 'ERR_SERVER_ALREADY_LISTEN');
        }
        this.listening = true;
        var socket = (options.newSocket || function(){return new net.Socket();})();
        this.onErrorOrTimeout(socket);
        const that = this;
        socket.on('close', function() {
            that.log.trace('socket close');
            socket.unpipe(that.fromAGW);
            that.toAGW.unpipe(that.socket);
        });
        socket.connect(this.options, function() {
            socket.pipe(that.fromAGW);
            that.toAGW.pipe(socket);
            that.socket = socket;
            that.toAGW.write({dataKind: 'G'}); // Get information about all ports
            that._connected(options, callback);
        });
    }

    _connected(options, callback) {
        const that = this;
        const hosts = Array.isArray(options.host) ? options.host : [options.host];
        var ports = options.port;
        if (ports != null) {
            ports = Array.isArray(ports) ? ports : [ports];
            for (var p = 0; p < ports.length; ++p) {
                ports[p] = parseInt(ports[p] + '');
            }
        } else {
            ports = this.ports;
            if (!ports) {
                // Postpone until we know what ports exist.
                this.listenBuffer = [options, callback];
                return;
            } else if (ports.length <= 0) {
                this.emit('error', newError('The TNC has no ports.', 'ENOENT'));
                return;
            }
        }
        this._address = {host: hosts, port: ports};
        if (callback) callback();
        this.emit('listening');
        ports.forEach(function(onePort) {
            hosts.forEach(function(oneHost) {
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
                that.log.trace('%sed %s; emit %s',
                               event, from.constructor.name, event);
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

exports.Reader = AGWReader;
exports.Writer = AGWWriter;
exports.Server = Server;

// The following are used for testing, only.
exports.fromHeader = fromHeader;
exports.getDataSummary = getDataSummary;
exports.toFrame = toFrame;
exports.HeaderLength = HeaderLength;
