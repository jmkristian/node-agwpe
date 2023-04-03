/** A command to communicate via AX.25 in conversational style.
    A connection to another station is initiated. Subsequently, each
    line from stdin is transmitted, and received data are written to
    stdout. A command mode enables sending and receiving files.
 */
const Bunyan = require('bunyan');
const bunyanFormat = require('bunyan-format');
const client = require('./client.js');
const fs = require('fs');
const minimist = require('minimist');
const OS = require('os');
const path = require('path');
const server = require('./server.js');
const Stream = require('stream');
const newError = server.newError;

[ // Close abruptly when bad signals happen:
    'SIGBUS', 'SIGFPE', 'SIGSEGV', 'SIGILL',
].forEach(function(signal) {
    process.on(signal, process.exit); // immediately
});

const args = minimist(process.argv.slice(2), {
    'boolean': ['debug', 'trace', 'debugTNC', 'traceTNC'],
});
const localAddress = args._[0];
const remoteAddress = args._[1];
const charset = (args.encoding || 'utf-8').toLowerCase();
const host = args.host || '127.0.0.1'; // localhost, IPv4
const ID = args.id; // TODO
const localPort = args['tnc-port'] || args.tncport || 0;
const port = args.port || args.p || 8000;
const remoteEOL = args.eol || '\r';
const via = Array.isArray(args.via) ? args.via.join(' ') : args.via; // TODO

const ESC = (args.escape != null) ? args.escape : '\x1D'; // GS = Ctrl+]
const TERM = (args.kill != null) ? args.kill : '\x1C'; // FS = Windows Ctrl+Break

const SeveralPackets = 2048; // The number of bytes in several AX.25 packets.
// Packets are rarely longer than 256 bytes.

const BS = '\x08'; // un-type previous character
const DEL = '\x7F'; // un-type previous character
const EOT = '\x04'; // Ctrl+D = flush line, or EOF at the start of a raw line.
const INT = '\x03'; // Ctrl+C = graceful kill
const prompt = 'cmd:';

const allINTs = new RegExp(INT, 'g');
const allNULs = new RegExp('\0', 'g');
const allRemoteEOLs = new RegExp(remoteEOL, 'g');
const allTERMs = TERM ? new RegExp(TERM, 'g') : null;
const inputBreak = new RegExp('\r|\n|' + EOT + (ESC ? '|' + ESC : ''));

const logStream = bunyanFormat({outputMode: 'short', color: false}, process.stderr);
const log = Bunyan.createLogger({
    name: 'Converse',
    level: args.trace ? Bunyan.TRACE : args.debug ? Bunyan.DEBUG : Bunyan.INFO,
    stream: logStream,
});
const agwLogger = Bunyan.createLogger({
    name: 'AGWPE',
    level: args.traceTNC ? Bunyan.TRACE : args.debugTNC ? Bunyan.DEBUG : Bunyan.INFO,
    stream: logStream,
});
['error', 'timeout'].forEach(function(event) {
    logStream.on(event, function(err) {
        process.stderr.write('logStream emitted ' + event
                             + '(' + (err || '') + ')' + OS.EOL);
    });
});

if (!(localAddress && remoteAddress)
    || localPort < 0
    || localPort > 255
    || (ESC && ESC.length > 1)
    || (TERM && TERM.length > 1)) {
    const myName = path.basename(process.argv[0])
          + ' ' + path.basename(process.argv[1]);
    process.stderr.write([
        `usage: ${myName} [options] <local call sign> <remote call sign>`,
        `--host <address>: TCP host of the TNC. default: 127.0.0.1`,
        `--port N: TCP port of the TNC. default: 8000`,
        `--tnc-port N: TNC port (sound card number). range 0-255. default: 0`,
        `--encoding <string>: encoding of characters to and from bytes. default: UTF-8`,
        `--eol <string>: represents end-of-line to the remote station. default: CR`,
        `--escape <character>: switch from conversation to command mode. default: Ctrl+]`,
        // TODO:
        // --id <call sign> FCC call sign (for use with tactical call)
        // --via <digipeater> (may be repeated)
        '',
    ].join(OS.EOL));
    process.exit(1);
}
log.debug('%j', {
    localPort: localPort,
    localAddress: localAddress,
    remoteAddress: remoteAddress,
    ESC: ESC,
    TERM: TERM,
});

/** Convert control characters to 'Ctrl+X format. */
function controlify(from) {
    var into = '';
    var wasControl = false;
    for (var f = 0; f < from.length; ++f) {
        var c = from.charCodeAt(f);
        if (c >= 32) {
            if (wasControl) into += ' ';
            into += from.charAt(f);
            wasControl = false;
        } else { // a control character
            if (into) into += ' ';
            into += 'Ctrl+' + String.fromCharCode(c + 64);
            wasControl = true;
        }
    }
    return into;
}
function messageFromAGW(info) {
    return info && info.toString(charset)
        .replace(allNULs, '')
        .replace(/^[\r\n]*/, '')
        .replace(/[\r\n]*$/, '')
        .replace(/[\r\n]+/g, OS.EOL);
}

function disconnectGracefully(signal) {
    log.debug('disconnectGracefully(%s)', signal || '');
    connection.end(); // should cause a 'close' event, eventually.
    // But in case it doesn't:
    setTimeout(function() {
        log.warn(`Connection didn't close.`);
        process.exit(3);
    }, 10000);
}
/** Handle input from stdin. When conversing, pipe it (to a connection).
    Otherwise interpret it as commands. We trust that conversation data
    may come fast (e.g. from copy-n-paste), but command data come slowly
    from a human being or a short script. Otherwise input may be lost,
    since we have flow control via pipe to a connection, but not flow
    control via write to stdout.
*/
class Interpreter extends Stream.Transform {
    constructor(stdout) {
        super({
            emitClose: false,
            defaultEncoding: charset,
            readableHighWaterMark: SeveralPackets,
            writableHighWaterMark: SeveralPackets,
        });
        const that = this;
        this.log = log;
        this.stdout = stdout;
        this.isConversing = true;
        this.exBuf = [];
        this.inBuf = '';
        this.cursor = 0;
        this.on('pipe', function(from) {
            that.raw = false;
            try {
                if (from.isTTY) {
                    from.setRawMode(true);
                    that.raw = true;
                }
            } catch(err) {
                that.log.warn(err);
            }
        });
        if (!this.isConversing) {
            stdout.write(prompt);
        }
    }
    _transform(chunk, encoding, callback) {
        var data = chunk.toString(charset);
        if (TERM && data.indexOf(TERM) >= 0) {
            this.emit('SIGTERM');
            data = data.replace(allTERMs, '')
        }
        if (INT && data.indexOf(INT) >= 0) {
            this.emit('SIGINT');
            data = data.replace(allINTs, '');
        }
        for (var brk; brk = data.match(inputBreak); ) {
            var end = brk.index + brk[0].length;
            this.log.debug('line break buffer[%d] = %j', end, brk[0]);
            this.exBuf.push(data.substring(0, end));
            data = data.substring(end);
        }
        this.exBuf.push(data);
        this.flushExBuf(callback);
    }
    _flush(callback) {
        this.flushExBuf(callback);
    }
    flushExBuf(callback) {
        if (callback) this.exBuf.push(callback);
        while (this.exBuf.length > 0 && !this.isWaiting) {
            var item = this.exBuf.shift();
            if ((typeof item) == 'function') {
                item(); // callback
            } else if (item) {
                this.parseInput(item);
            }
        }
    }
    output(data) {
        if (this.isConversing) {
            this.push(data, charset);
        } else {
            this.stdout.write(data, charset);
        }
    }
    parseInput(data) {
        this.log.trace('parseInput(%j)', data);
        this.inBuf += data;
        if (EOT) {
            const eot = this.inBuf.indexOf(EOT);
            if (eot == 0 && this.raw) {
                this.log.debug('EOT raw = end of file');
                this.inBuf = '';
                this.end(); // end of file
            } else if (eot >= 0) { // flush partial line
                this.log.debug('EOT');
                if (this.isConversing) {
                    this.output(this.inBuf.substring(0, eot));
                    this.inBuf = this.inBuf.substring(eot + EOT.length);
                } else {
                    this.inBuf = this.inBuf.substring(0, eot)
                        + this.inBuf.substring(eot + EOT.length);
                }
            }
        }
        for (var brk; brk = this.inBuf.match(inputBreak); ) {
            var end = brk.index;
            brk = brk[0];
            switch(brk) {
            case '\n':
            case '\r':
                var skipLF = brk == '\n' && this.foundCR;
                this.foundCR = false;
                if (!skipLF) {
                    var line = this.inBuf.substring(0, end);
                    if (this.raw) {
                        var echo = (line + OS.EOL).substring(this.cursor);
                        this.log.trace('echo %j', echo);
                        this.stdout.write(echo);
                    }
                    if (this.isConversing) {
                        this.output(line + remoteEOL);
                    } else {
                        this.executeCommand(line);
                    }
                    this.cursor = 0;
                    if (brk == '\r') {
                        this.foundCR = true;
                    }
                }
                this.inBuf = this.inBuf.substring(end + 1);
                break;
            default: // ESC
                this.log.debug('ESC %j', brk);
                if (this.isConversing) {
                    this.output(this.inBuf.substring(0, end));
                    this.inBuf = this.inBuf.substring(end + brk.length);
                    this.isConversing = false;
                    this.cursor = 0;
                    this.output(OS.EOL + prompt);
                } else { // already in command mode
                    // Ignore the ESC:
                    this.inBuf = this.inBuf.substring(0, end)
                        + this.inBuf.substring(end + brk.length);
                }
            }
        }
        if (this.raw) {
            while (this.inBuf.endsWith(BS) || this.inBuf.endsWith(DEL)) {
                this.inBuf = this.inBuf.substring(0, this.inBuf.length - BS.length - 1);
            }
            var echo = '';
            for ( ; this.cursor > this.inBuf.length; --this.cursor) {
                echo += BS + ' ' + BS;
            }
            if (this.cursor < this.inBuf.length) {
                echo += this.inBuf.substring(this.cursor);
                this.cursor = this.inBuf.length;
            }
            if (echo) this.stdout.write(echo);
        }
    } // parseInput
    executeCommand(line) {
        const that = this;
        try {
            if (!this.raw) {
                this.stdout.write(line + OS.EOL);
            }
            const parts = line.trim().split(/\s+/);
            switch (parts[0].toLowerCase()) {
            case '':
                break;
            case 'b': // disconnect
                connection.end();
                return;
            case 'c': // converse
                if (ESC) {
                    console.log(`Type ${controlify(ESC)} to return to command mode.${OS.EOL}`)
                }
                this.isConversing = true;
                return;
            case 'r': // receive a file
                this.output(`receive a file...${OS.EOL}`);
                break;
            case 's': // send a file
                if (this.sendingStream) {
                    this.sendingStream.destroy();
                    delete this.sendingStream;
                }
                if (parts[1]) {
                    this.sendingStream = fs.createReadStream(parts[1], {
                        encoding: 'binary',
                        highWaterMark: SeveralPackets,
                    });
                    this.sendingStream.on('error', function(err) {
                        console.log(err);
                    });
                    this.sendingStream.on('close', function() {
                        const bytes = that.sendingStream.bytesRead;
                        that.output(`${OS.EOL}Sending ${bytes} bytes to ${remoteAddress}.${OS.EOL}`);
                        delete that.sendingStream;
                        if (!that.isConversing) that.output(prompt);
                    });
                    // Don't close the connection when the file closes:
                    this.sendingStream.pipe(new Stream.Transform({
                        encoding: 'binary',
                        transform: function(chunk, encoding, callback) {
                            connection.write(chunk, encoding, callback);
                        },
                    }));
                    console.log(`Sending to %s from %s.`, remoteAddress, parts[1]);
                }
                break;
            case 'w': // wait
                if (parts[1]) {
                    const secs = parseInt(parts[1]);
                    if (isNaN(secs)) {
                        throw newError(`${parts[1]} isn't an integer.`,
                                       'ERR_INVALID_ARG_VALUE');
                    }
                    this.output(`Wait for ${secs} seconds ...${OS.EOL}`);
                    setTimeout(function(that) {
                        that.output(prompt);
                        that.isWaiting = false;
                        that.flushExBuf();
                    }, secs * 1000, this);
                } else {
                    this.output(`Wait until ${remoteAddress} disconnects ...${OS.EOL}`);
                }
                this.isWaiting = true;
                return; // no prompt
            case '?':
            case 'h': // show all available commands
                this.output([
                    'Available commands are:',
                    'B: disconnect from the remote station.',
                    'C: converse with the remote station.',
                    // TODO:
                    // 'R [file name]: receive a binary file from the remote station',
                    // '  If no file name is given, stop receiving to the file.',
                    'S [file name]: send a binary file to the remote station.',
                    '  If no file name is given, stop sending from the file.',
                    'W [N]: wait for N seconds.',
                    '  If N is not given, wait until disconnected.',
                    '',
                    'Commands are case-insensitive.',
                    '',].join(OS.EOL));
                break;
            default:
                this.output([
                    `${line}?`,
                    `Type H to see a list of commands.`,
                    '',].join(OS.EOL));
            }
        } catch(err) {
            this.log.warn(err);
        }
        this.output(prompt);
    } // executeCommand
} // Interpreter

class Receiver extends Stream.Transform {
    constructor() {
        super({
            emitClose: false,
        });
        this.partialEOL = '';
    }
    _transform(chunk, encoding, callback) {
        // TODO: handle a multi-character remoteEOL split across several chunks.
        const data = chunk.toString(charset);
        log.trace('< %s', JSON.stringify(data));
        this.push(data.replace(allRemoteEOLs, OS.EOL), charset);
        callback();
    }
}

const receiver = new Receiver();
const interpreter = new Interpreter(process.stdout);
const connection = client.createConnection({
    host: host,
    port: port,
    remoteAddress: remoteAddress.toUpperCase(),
    localAddress: localAddress.toUpperCase(),
    localPort: localPort,
    logger: agwLogger,
}, function connectListener(info) {
    console.log(messageFromAGW(info) || `Connected to ${remoteAddress}`);
    process.stdin.pipe(interpreter).pipe(connection);
    if (ESC) {
        console.log(`Type ${controlify(ESC)} to enter command mode.${OS.EOL}`);
    }
});
connection.on('close', function(info) {
    log.debug('connection emitted close(%j)', info || '')
    console.log(messageFromAGW(info) || `Disconnected from ${remoteAddress}`);
    setTimeout(process.exit, 10);
});
['error', 'timeout'].forEach(function(event) {
    connection.on(event, function(err) {
        log.warn('connection emitted %s(%s)', event, err || '');
    });
});
connection.pipe(receiver).pipe(process.stdout);
['end', 'close'].forEach(function(event) {
    receiver.on(event, function(info) {
        log.debug('receiver emitted %s(%s)', event, info || '');
    });
    interpreter.on(event, function(info) {
        log.debug('interpreter emitted %s(%s)', event, info || '');
        disconnectGracefully();
    });
});
['drain', 'pause', 'resume'].forEach(function(event) {
    interpreter.on(event, function(info) {
        log.debug('interpreter emitted %s(%s)', event, info || '');
    });
});
[
    'SIGHUP', // disconnected or console window closed
    'SIGINT', // Ctrl+C
].forEach(function(signal) {
    process.on(signal, function(info) {
        log.debug('process received %s(%s)', signal, info || '');
        disconnectGracefully(signal);
    });
    interpreter.on(signal, function(info) {
        log.debug('interpreter emitted %s(%s)', signal, info || '');
        disconnectGracefully(signal);
    });
});
process.on('SIGTERM', function(info) {
    log.debug('process received SIGTERM(%s)', info || '');
    setTimeout(process.exit, 10);
});
interpreter.on('SIGTERM', function(info) {
    log.debug('interpreter emitted SIGTERM(%s)', info || '');
    setTimeout(process.exit, 10);
});

var availablePorts = '';
connection.on('frameReceived', function(frame) {
    switch(frame.dataKind) {
    case 'G':
        log.debug('frameReceived G');
        availablePorts = frame.data.toString(charset);
        break;
    case 'X':
        log.debug('frameReceived %j', frame);
        if (!(frame.data && frame.data.toString('binary') == '\x01')) {
            try {
                const message = `The TNC has no port ${frame.port}.`;
                // log.debug(newError(message, 'ENOENT'));
                const parts = availablePorts.split(';');
                const portCount = parseInt(parts[0]);
                const lines = [];
                if (portCount <= 0) {
                    lines.push(message);
                } else {
                    lines.push(message + ' The available ports are:');
                    for (var p = 0; p < portCount; ++p) {
                        var description = parts[p + 1];
                        var sp = description.match(/\s+/);
                        if (sp) description = description.substring(sp.index + sp[0].length);
                        lines.push(p + ': ' + description);
                    }
                }
                process.stderr.write(lines.join(OS.EOL) + OS.EOL + OS.EOL);
            } catch(err) {
                log.error(err);
            }
            connection.destroy();
        }
        break;
    default:
    }
});
