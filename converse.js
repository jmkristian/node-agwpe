/** A 'terminal' style command to communicate via AX.25.
    A connection to another station is initiated. Subsequently, each
    line from stdin is transmitted, and received data are written to
    stdout. A command mode enables sending and receiving files.
 */
const Bunyan = require('bunyan');
const bunyanFormat = require('bunyan-format');
const client = require('./client.js');
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

const logStream = bunyanFormat({outputMode: 'short', color: false}, process.stderr);
const log = Bunyan.createLogger({
    name: 'converse',
    level: Bunyan.INFO,
    stream: logStream,
});
const agwLogger = Bunyan.createLogger({
    name: 'AGWPE',
    level: Bunyan.WARN,
    stream: logStream,
});
['error', 'timeout'].forEach(function(event) {
    logStream.on(event, function(err) {
        process.stderr.write('logStream emitted %s(%s)%s', event, err || '', OS.EOL);
    });
});

const args = minimist(process.argv.slice(2));
const localAddress = args._[0];
const remoteAddress = args._[1];
const charset = args.encoding || 'utf-8';
const ESC = args.esc || '\x1D'; // Ctrl+]
const host = args.host || '127.0.0.1'; // localhost, IPv4
const ID = args.id;
const localPort = args['tnc-port'] || args.tncport || 0;
const port = args.port || args.p || 8000;
const remoteEOL = args.eol || '\r';
const via = Array.isArray(args.via) ? args.via.join(' ') : args.via;

const BS = '\x08';
const DEL = '\x7F';
const ctrlC = '\x03';
const prompt = 'cmd:';

if (!(localAddress && remoteAddress) || localPort < 0 || localPort > 255) {
    const myName = path.basename(process.argv[0])
          + ' ' + path.basename(process.argv[1]);
    process.stderr.write([
        `usage: ${myName} [options] <local call sign> <remote call sign>`,
        `--host <address>: TCP host of the TNC. default: 127.0.0.1`,
        `--port N: TCP port of the TNC. default: 8000`,
        `--tnc-port N: TNC port (sound card number). range 0-255. default: 0`,
        `--encoding <string>: encoding of characters to and from bytes. default: utf-8`,
        `--eol <string>: represents end-of-line to the remote station. default: CR`,
        `--esc <character>: switch from conversation to command mode. default: Ctrl+]`,
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
        .replace(new RegExp('\0', 'g'), '')
        .replace(/^[\r\n]*/, '')
        .replace(/[\r\n]*$/, '')
        .replace(/[\r\n]+/g, OS.EOL);
}

const connection = client.createConnection({
    host: host,
    port: port,
    remoteAddress: remoteAddress,
    localAddress: localAddress,
    localPort: localPort,
    logger: agwLogger,
}, function connectListener(info) {
    console.log(messageFromAGW(info) || `Connected to ${remoteAddress}`);
    console.log(`Type ${controlify(ESC)} to enter command mode.${OS.EOL}`);
});
['error', 'timeout'].forEach(function(event) {
    connection.on(event, function(err) {
        log.warn('connection emitted %s(%s)', event, err || '');
    });
});
connection.on('close', function(info) {
    log.debug('connection emitted close(%j)', info || '')
    console.log(messageFromAGW(info) || `Disconnected from ${remoteAddress}`);
    setTimeout(process.exit, 10);
});

function disconnectGracefully(signal) {
    console.log('Disconnecting ...' + (signal ? ` (${signal})` : ''));
    connection.end(); // should cause a 'close' event, eventually.
    // But in case it doesn't:
    setTimeout(function() {
        log.error(`Connection didn't close.`);
        process.exit(3);
    }, 10000);
}

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
                const message = `There is no TNC port ${frame.port}.`;
                // log.debug(newError(message, 'ENOENT'));
                const parts = availablePorts.split(';');
                const lines = [message + ' Available TNC ports are:'];
                const portCount = parseInt(parts[0]);
                for (var p = 0; p < portCount; ++p) {
                    var description = parts[p + 1];
                    var sp = description.match(/\s+/);
                    if (sp) description = description.substring(sp.index + sp[0].length);
                    lines.push(p + ': ' + description);
                }
                process.stderr.write(lines.join(OS.EOL) + OS.EOL);
            } catch(err) {
                log.error(err);
            }
            connection.destroy();
        }
        break;
    default:
    }
});

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
        });
        const that = this;
        this.log = log;
        this.stdout = stdout;
        this.buffer = '';
        this.cursor = 0;
        this.conversing = true;
        if (!this.conversing) {
            this.output(prompt);
        }
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
    }
    _transform(chunk, encoding, callback) {
        var data = chunk.toString(charset);
        for (var kill; (kill = data.indexOf(ctrlC)) >= 0; ) {
            this.emit('SIGINT');
            data = data.substring(0, kill) + data.substring(kill + 1);
        }
        for (var esc; (esc = data.indexOf(ESC)) >= 0; ) {
            this.onBreak();
            this.buffer = data = '';
            this.cursor = 0;
        }
        this.buffer += data;
        for (var eol; eol = this.buffer.match(/[\r\n]/); ) {
            eol = eol.index;
            var skipLF = this.foundCR && this.buffer.charAt(eol) == '\n';
            this.foundCR = false;
            if (!skipLF) {
                var line = this.buffer.substring(0, eol);
                if (this.raw) {
                    var echo = (line + OS.EOL).substring(this.cursor);
                    this.log.trace('Interpreter echo %j', echo);
                    this.stdout.write(echo);
                }
                this.onLine(line); 
                this.cursor = 0;
                if (this.buffer.charAt(eol) == '\r') {
                    this.foundCR = true;
                }
            }
            this.buffer = this.buffer.substring(eol + 1);
        }
        if (this.raw) {
            while (this.buffer.endsWith(BS) || this.buffer.endsWith(DEL)) {
                this.buffer = this.buffer.substring(0, this.buffer.length - BS.length - 1);
            }
            var echo = '';
            if (this.cursor < this.buffer.length) {
                echo += this.buffer.substring(this.cursor);
                this.cursor = this.buffer.length;
            } else {
                for ( ; this.cursor > this.buffer.length; --this.cursor) {
                    echo += BS + ' ' + BS;
                }
            }
            if (echo) this.stdout.write(echo);
        }
        if (callback) callback();
    }
    _flush(callback) {
        if (this.buffer) {
            this.onLine(this.buffer);
            this.buffer = '';
        }
        if (callback) callback();
    }
    output(data) {
        if (this.conversing) {
            this.push(data, charset);
        } else {
            this.stdout.write(data, charset);
        }
    }
    onBreak() {
        this.log.debug('Interpreter onBreak');
        if (this.conversing) {
            this.conversing = false;
            this.output(OS.EOL + prompt);
        }
    }
    onLine(line) {
        if (this.log.trace()) this.log.trace('input line ' + JSON.stringify(line));
        if (this.conversing) {
            this.output(line + remoteEOL);
        } else { // command mode
            if (!this.raw) {
                this.stdout.write(line + OS.EOL);
            }
            switch (line.trim().split(/\s+/)[0].toLowerCase()) {
            case '':
                break;
            case 'b': // disconnect
                connection.end();
                return;
            case 'c': // converse
                this.output(`Type ${controlify(ESC)} to return to command mode.${OS.EOL}`)
                this.conversing = true;
                return;
            case 'r': // receive a file
                this.output(`receive a file...${OS.EOL}`);
                break;
            case 's': // send a file
                this.output(`send a file...${OS.EOL}`);
                break;
            case '?':
            case 'h': // show all available commands
                this.output([
                    'Available commands are:',
                    'B: disconnect from the remote station',
                    'C: converse with the remote station',
                    // TODO:
                    // 'R <file name>: receive a file from the remote station and disconnect',
                    // 'S <file name>: send a file to the remote station',
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
            this.output(prompt);
        }
    } // onLine
} // Interpreter

class Receiver extends Stream.Transform {
    constructor() {
        super({
            emitClose: false,
        });
        this.EOLPattern = new RegExp(remoteEOL, 'g');
        this.partialEOL = '';
    }
    _transform(chunk, encoding, callback) {
        // TODO: handle a multi-character remoteEOL split across several chunks.
        const data = chunk.toString(charset);
        log.trace('received %s', JSON.stringify(data));
        this.push(data.replace(this.EOLPattern, OS.EOL), charset);
        callback();
    }
}

const receiver = new Receiver();
const interpreter = new Interpreter(process.stdout);
['finish', 'end', 'close'].forEach(function(event) {
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

process.stdin.pipe(interpreter).pipe(connection);
connection.pipe(receiver).pipe(process.stdout);
