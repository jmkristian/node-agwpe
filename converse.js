/** A 'terminal' style command to communicate via AX.25.
    A connection to another station is initiated.
    Subsequently, each line from stdin is transmitted,
    and received data are written to stdout.
    A small command language supports sending and
    receiving files.
 */
const Bunyan = require('bunyan');
const client = require('./client.js');
const minimist = require('minimist');
const OS = require('os');
const path = require('path');
const server = require('./server.js');
const Stream = require('stream');

[ // Close abruptly when bad signals happen:
    // 'SIGBREAK', // Windows Ctrl+Break
    // 'SIGKILL', // Unix `kill -9` or `kill -s SIGKILL`
    'SIGBUS', 'SIGFPE', 'SIGSEGV', 'SIGILL', // very bad
].forEach(function(signal) {
    process.on(signal, process.exit); // immediately
});

const logStream = new Stream.Writable({
    objectMode: true,
    write: function(item, encoding, callback) {
        var c = item['class'];
        c = c ? c + ' ' : '';
        process.stderr.write(`${item.level}: ${c}${item.msg}${OS.EOL}`);
        callback();
    },
});
['error', 'timeout'].forEach(function(event) {
    logStream.on(event, function(err) {
        process.stderr.write('logStream emitted %s(%s)%s', event, err || '', OS.EOL);
    });
});
const log = Bunyan.createLogger({
    name: 'client',
    level: Bunyan.INFO,
    streams: [{
        type: "raw",
        stream: logStream,
    }],
});
const agwLogger = Bunyan.createLogger({
    name: 'client',
    level: Bunyan.WARN,
    streams: [{
        type: "raw",
        stream: logStream,
    }],
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
const EOLPattern = new RegExp(remoteEOL, 'g');

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

const connection = client.createConnection({
    host: host,
    port: port,
    remoteAddress: remoteAddress,
    localAddress: localAddress,
    localPort: localPort,
    logger: agwLogger,
});
['error', 'timeout'].forEach(function(event) {
    connection.on(event, function(err) {
        log.warn('%s emitted %s(%s)',
                 connection.constructor.name, event, err || '');
    });
});
var availablePorts = '';
connection.on('receivedFrame', function(frame) {
    switch(frame.dataKind) {
    case 'G':
        log.trace('spy < %s', frame.dataKind);
        availablePorts = frame.data.toString(charset);
        break;
    case 'X':
        log.trace('spy < %s', frame.dataKind);
        if (!(frame.data && frame.data.toString('binary') == '\x01')) {
            try {
                const err = new Error(`There is no TNC port ${frame.port}.`);
                err.code = 'ENOENT';
                log.error(err);
                const parts = availablePorts.split(';');
                const lines = ['Available TNC ports are:'];
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
    throttle.onFrameFromAGW(frame);
});

class Readline extends Stream.Transform {
    constructor(raw) {
        super({defaultEncoding: charset});
        this.buffer = '';
        this.cursor = 0;
        const that = this;
        this.on('pipe', function(from) {
            this.raw = false;
            try {
                if (from.isTTY) {
                    from.setRawMode(true);
                    this.raw = true;
                }
            } catch(err) {
                log.warn(err);
            }
        });
    }
    _transform(chunk, encoding, callback) {
        var data = chunk.toString(charset);
        for (var kill; (kill = data.indexOf('\x03')) >= 0; ) {
            log.trace('Readline emit SIGINT');
            this.emit('SIGINT');
            data = data.substring(0, kill) + data.substring(kill + 1);
        }
        for (var esc; (esc = data.indexOf(ESC)) >= 0; ) {
            log.trace('Readline emit break');
            this.emit('break');
            this.buffer = data = '';
            this.cursor = 0;
            // data = data.substring(0, esc) + data.substring(esc + ESC.length);
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
                    log.trace('Readline push %j', echo);
                    this.push(echo);
                }
                log.trace('Readline emit line %s', line);
                this.emit('line', line); 
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
            if (this.cursor < this.buffer.length) {
                this.push(this.buffer.substring(this.cursor));
                this.cursor = this.buffer.length;
            } else {
                while (this.cursor > this.buffer.length) {
                    this.push(BS + ' ' + BS);
                    --this.cursor;
                }
            }
        }
        if (callback) callback();
    }
    _flush(callback) {
        if (this.buffer) {
            this.emit('line', this.buffer);
            this.buffer = '';
        }
        if (callback) callback();
    }
}

const user = new Readline();
process.stdin.pipe(user).pipe(process.stdout);

function disconnectGracefully(signal) {
    log.info('%s disconnecting...', signal);
    connection.destroy();
    setTimeout(function() {
        process.exit(3);
    }, 2000);
}
[ // Close gracefully:
    'SIGHUP', // disconnected or console window closed
    'SIGINT', // Ctrl+C
].forEach(function(signal) {
    process.on(signal, function(info) {
        log.debug('process received %s(%s)', signal, info || '');
        disconnectGracefully(signal);
    });
    user.on(signal, function(info) {
        log.debug('user emitted %s(%s)', signal, info || '');
        disconnectGracefully(signal);
    });
});
['finish', 'end', 'close'].forEach(function(event) {
    user.on(event, function(info) {
        log.trace('user emitted %s(%s)', event, info || '');
        connection.destroy();
    });
});

const prompt = 'cmd:';
var conversing = true;
if (conversing) {
    console.log(`Type ${controlify(ESC)} to enter command mode.`);
} else {
    user.push(prompt);
}
user.on('break', function() {
    if (conversing) {
        conversing = false;
        user.push(OS.EOL + prompt);
    }
});
user.on('line', function(line) {
    if (log.debug()) log.debug('user line ' + JSON.stringify(line));
    if (conversing) {
        log.debug('transmit %s', JSON.stringify(line));
        connection.write(line + remoteEOL, charset);
    } else { // command mode
        switch (line.trim().split(/\s+/)[0].toLowerCase()) {
        case '':
            break;
        case 'b': // disconnect
            connection.destroy();
            user.destroy();
            return;
        case 'c': // converse
            console.log(`Type ${controlify(ESC)} to return to command mode.`)
            conversing = true;
            return;
        case 'r': // receive a file
            console.log(`receive a file...`);
            break;
        case 's': // send a file
            console.log(`send a file...`);
            break;
        case '?':
        case 'h': // show all available commands
            [
                'Available commands are:',
                'B: disconnect from the remote station',
                'C: converse with the remote station',
                // TODO:
                // 'R <file name>: receive a file from the remote station and disconnect',
                // 'S <file name>: send a file to the remote station',
                '',
            ].forEach(function(line) {console.log(line);});
            break;
        default:
            console.log(`${line}?`);
            console.log(`Type H to see a list of commands.`);
        }
        user.push(prompt);
    }
});
connection.on('data', function(data) {
    log.debug('received %s', JSON.stringify(data));
    process.stdout.write(data.toString(charset).replace(EOLPattern, OS.EOL));
});
connection.on('close', function(info) {
    log.debug('connection emitted close(%s)', info || '');
    process.exit();
});
