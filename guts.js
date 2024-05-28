'use strict';

const Stream = require('stream');

const DefaultFrameLength = 128;
const HeaderLength = 36;
const NoPID = 0xF0;

const LogNothing = {
    child: function(){return LogNothing;},
    trace: function(){},
    debug: function(){},
    info: function(){},
    warn: function(){},
    error: function(){},
    fatal: function(){},
};

const sTypes = ['RR', 'RNR', 'REJ', 'SREJ'];
const uTypes = [];
for (var u = 0; u <= 0x1C; ++u) uTypes.push(null);
uTypes[0x0F] = 'SABME';
uTypes[0x07] = 'SABM';
uTypes[0x08] = 'DISC';
uTypes[0x03] = 'DM';
uTypes[0x0C] = 'UA';
uTypes[0x10] = 'FRMR';
uTypes[0x00] = 'UI';
uTypes[0x17] = 'XID';
uTypes[0x1C] = 'TEST';
const controlBits = {
    I: 0,
    RR: 0x1,
    RNR: 0x5,
    REJ: 0x9,
    SREJ: 0xD,
    SABME: 0x6F,
    SABM: 0x2F,
    DISC: 0x43,
    DM: 0x0F,
    UA: 0x63,
    FRMR: 0x87,
    UI: 0x03,
    XID: 0xAF,
    TEST: 0xC3,
};

function newError(message, code) {
    const err = new Error(message);
    if (code) err.code = code;
    return err;
}

function checkNodeVersion() {
    const version = process.versions.node;
    const parts = version.split('.').map(s => parseInt(s));
    if (parts[0] < 8 || (parts[0] == 8 && parts[1] < 17)) {
        throw new Error('node-agwpe works with version 8.17.0 or later (not ' + version + ').');
    }
}

function validateCallSign(name, value) {
    if (!value) throw newError(`The ${name} call sign is "${value}".`, 'ERR_INVALID_ARG_VALUE');
    var end = value.indexOf('-');
    if (end < 0) end = value.length;
    if (end > 6) {
        throw newError(`The ${name} call sign "${value.substring(0, end)}" is too long.`
                       + ` The limit is 6 characters.`,
                       'ERR_INVALID_ARG_VALUE');
    }
    var wrong = value.substring(0, end).replace(/[a-zA-Z0-9\/]/g, '');
    if (wrong) {
        throw newError(`The ${name} call sign contains ${JSON.stringify(wrong)}.`,
                       'ERR_INVALID_ARG_VALUE');
    }
    if (end < value.length - 1) {
        const SSID = value.substring(end + 1);
        const n = parseInt(SSID);
        if (!(n >= 0 && n <= 15)) {
            throw newError(`The ${name} SSID "${SSID}" is outside the range 0..15.`,
                           'ERR_OUT_OF_RANGE');
        }
    }
    return value.toUpperCase();
}

function validatePort(port) {
    if (port == null) throw newError(`The TNC port is "${port}".`,'ERR_INVALID_ARG_VALUE');
    var result = parseInt(`${port}`);
    if (!(result >= 0 && result <= 255)) {
        throw newError(`TNC port "${port}" is outside the range 0..255.`,
                       'ERR_OUT_OF_RANGE');
    }
    return result;
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

function copyBuffer(from, start, end) {
    if (start == null) start = 0;
    if (end == null || end > from.length) end = from.length;
    var into = Buffer.alloc(end - start);
    from.copy(into, 0, start, end);
    return into;
}

function getDataSummary(data) {
    if (data.length <= 32) {
        return data.toString('binary').replace(/\r/g, '\\r');
    } else {
        return data.toString('binary', 0, 32).replace(/\r/g, '\\r') + '...';
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

function encodeCallSign(buffer, start, call) {
    if (start + 7 > buffer.length) throw newError(
        "There's no room for a call sign at offset " + start
            + " in " + hexBuffer(buffer), 'ERR_OUT_OF_RANGE');
    const parts = call.split('-');
    const base = parts[0];
    const ssid = parts[1] ? parseInt(parts[1]) : 0;
    if (base.length > 6) throw newError(
        base + ' length > 6', 'ERR_OUT_OF_RANGE');
    for (var b = 0; b < 6; ++b) {
        var c = (b >= base.length) ? 0x20 : base.charCodeAt(b) & 0x7F;
        buffer[start + b] = (c << 1);
    }
    buffer[start + 6] = ssid << 1;
}

function decodeCallSign(buffer, start) {
    if (start + 7 > buffer.length) throw newError(
        "There's no room for a call sign at offset " + start
            + " in " + hexBuffer(buffer), 'ERR_OUT_OF_RANGE');
    var call = '';
    for (var b = start; b < start + 6; ++b) {
        var c = String.fromCharCode(buffer[b] >> 1);
        if (c == ' ') break;
        call += c;
    }
    var ssid = (buffer[start + 6] >> 1) & 0xF;
    if (ssid) {
        call += '-' + ssid;
    }
    return call;
}

/** Transform an object to a binary AX.25 packet. */
function encodePacket(packet) {
    validatePort(packet.port);
    validateCallSign('destination', packet.toAddress);
    validateCallSign('source', packet.fromAddress);
    if (packet.info && !Buffer.isBuffer(packet.info)) {
        throw newError(
            `The packet info field must be a Buffer (not ${typeof packet.info}).`,
            'ERR_INVALID_ARG_TYPE');
    }
    const via = !packet.via ? []
          : Array.isArray(packet.via) ? packet.via
          : ('' + packet.via).trim().split(/[\s,]+/);
    const hasPID = (packet.type == 'I' || packet.type == 'UI');
    const buffer = Buffer.alloc(
        14 // source and destination addresses
            + (via.length * 7) // digipeater addresses
            + 1 // control field
            + (hasPID ? 1 : 0) // PID
            + (packet.info ? packet.info.length : 0)
    );
    encodeCallSign(buffer, 0, packet.toAddress);
    encodeCallSign(buffer, 7, packet.fromAddress);
    var next = 14;
    via.forEach(function(digi) {
        encodeCallSign(buffer, next, digi);
        next += 7;
    });
    buffer[next - 1] += 1; // end of addresses
    var control = controlBits[packet.type] || 0;
    switch(packet.type) {
    case 'SABME':
    case 'SABM':
    case 'DISC':
    case 'UI':
        if (packet.P) control += 0x10;
        break;
    case 'DM':
    case 'UA':
    case 'FRMR':
        if (packet.F) control += 0x10;
        break;
    case 'RR':
    case 'RNR':
    case 'REJ':
    case 'SREJ':
        control += (packet.NR & 7) << 5;
        if (packet.P) {
            buffer[6] += 0x80;
        } else if (packet.F) {
            buffer[13] += 0x80;
        }
        break;
    case 'I':
        if (packet.P) control += 0x10;
        control += (packet.NR & 7) << 5;
        control += (packet.NS & 7) << 1;
        break;
    default:
    }
    buffer[next++] = control;
    if (hasPID) {
        buffer[next++] = (packet.PID != null) ? packet.PID : NoPID;
    }
    if (packet.info) {
        packet.info.copy(buffer, next);
    }
    return buffer;
}

/** Transform a binary AX.25 packet to an object. */
function decodePacket(buffer) {
    const result = {};
    var next = 0;
    result.toAddress = decodeCallSign(buffer, 0);
    var toC = (buffer[6] >> 7) != 0;
    result.fromAddress = decodeCallSign(buffer, 7);
    var fromC = (buffer[13] >> 7) != 0;
    if (toC && !fromC) result.command = true;
    if (!toC && fromC) result.response = true;
    var via = [];
    for (next = 14; (buffer[next - 1] & 1) == 0; next += 7) {
        var call = decodeCallSign(buffer, next);
        if (buffer[next + 6] >> 7) call += '*';
        via.push(call);
    }
    if (via.length > 0) {
        result.via = via;
    }
    if (next >= buffer.length) throw newError(
        'No control field in ' + hexBuffer(buffer),
        'ERR_BUFFER_OUT_OF_BOUNDS');
    const control = buffer[next++];
    var type = (control & 1) == 0 ? 'I' : (control & 2) == 0 ? 'S' : 'U';
    switch(type) {
    case 'U':
        type = uTypes[((control & 0xE0) >> 3) + ((control >> 2) & 3)];
        break;
    case 'S':
        type = sTypes[(control >> 2) & 3];
        result.NR = (control >> 5);
        break;
    case 'I':
        result.NR = (control >> 5);
        result.NS = (control >> 1) & 7;
        break;
    default:
    }
    switch(type) {
    case 'I':
    case 'UI':
        if (next >= buffer.length) throw newError(
            'No PID field in ' + type + ' ' + hexBuffer(buffer),
            'ERR_BUFFER_OUT_OF_BOUNDS');
        var PID = buffer[next++];
        switch(PID) {
        case NoPID: // no protocol
            break;
        case 0xFF:
        case 0x08:
            if (next >= buffer.length) throw newError(
                'No escaped PID field in ' + type + ' ' + hexBuffer(buffer),
                'ERR_BUFFER_OUT_OF_BOUNDS');
            result.PID = buffer[next++];
            break;
        default:
            result.PID = PID;
        }
    default:
    }
    if ((control >> 4) & 1) { // the Poll/Final bit
        switch(type) {
        case 'SABM':
        case 'SABME':
        case 'DISC':
        case 'I':
            result.P = true;
            break;
        case 'DM':
        case 'UA':
        case 'FRMR':
            result.F = true;
            break;
        case 'RR':
        case 'RNR':
        case 'REJ':
        case 'SREJ':
            if (result.command) {
                result.P = true;
            } else {
                result.F = true;
            }
            break;
        default:
        }
    }
    if (type != null) result.type = type;
    if (next < buffer.length) {
        result.info = copyBuffer(buffer, next);
    }
    return result;
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

function getASCII(frame, offset) {
    var into = '';
    for (var i = offset; frame[i]; ++i) {
        into = into + String.fromCharCode(frame[i]);
    }
    return into;
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

/** Transform binary AGWPE frames to objects. */
exports.checkNodeVersion = checkNodeVersion;
exports.copyBuffer = copyBuffer;
exports.decodePacket = decodePacket;
exports.DefaultFrameLength = DefaultFrameLength;
exports.encodePacket = encodePacket;
exports.getDataSummary = getDataSummary;
exports.getFrameSummary = getFrameSummary;
exports.getLogger = getLogger;
exports.HeaderLength = HeaderLength;
exports.hexBuffer = hexBuffer;
exports.hexByte = hexByte;
exports.LogNothing = LogNothing;
exports.newError = newError;
exports.Receiver = Receiver;
exports.Sender = Sender;
exports.validateCallSign = validateCallSign;
exports.validatePort = validatePort;
