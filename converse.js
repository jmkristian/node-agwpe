/** A 'terminal' style command to communicate via AX.25.
    A connection to another station is initiated.
    Subsequently, each line from stdin is transmitted,
    and received data are written to stdout.
    A small command language supports sending and
    receiving files.
 */
const Bunyan = require('bunyan');
const minimist = require('minimist');
const mockNet = require('./spec/mockNet/mockNet.js');
const Net = require('net');
const OS = require('os');
const path = require('path');
const server = require('./server.js');
const Stream = require('stream');
const TTY = require('tty');

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
const agwLog = Bunyan.createLogger({
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
const ID = args.id;
const remoteEOL = args.eol || '\r';
const via = Array.isArray(args.via) ? args.via.join(' ') : args.via;

const BS = '\x08';
const DEL = '\x7F';
const EOLPattern = new RegExp(remoteEOL, 'g');

if (!(localAddress && remoteAddress)) {
    const myName = path.basename(process.argv[0])
          + ' ' + path.basename(process.argv[1]);
    process.stderr.write([
        `usage: ${myName} [options] localCallSign remoteCallSign`,
        `--encoding <string>: encoding of characters to & from bytes. default: utf-8`,
        `--eol <string>: represents end-of-line to the remote station. default: CR`,
        `--esc <character>: switch from conversation to command mode. default: Ctrl+]`,
        // TODO:
        // --id <call sign> FCC call sign (for use with tactical call)
        // --via <digipeater> (may be repeated)
        '',
    ].join(OS.EOL));
    process.exit(1);
}
log.debug('%j', {localAddress: localAddress, remoteAddress: remoteAddress});

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

const receiver = new server.Reader({logger: agwLog});
const sender = new server.Writer({logger: agwLog});
const socket = Net.createConnection({
    host: '127.0.0.1',
    port: 8000,
    connectListener: function() {
        log.info('Connected to ${remoteAddress}');
    },
});
const throttle = new server.ConnectionThrottle({logger: agwLog}, {
    port: 0,
    callTo: localAddress,
    callFrom: remoteAddress,
});
const dataToFrames = new server.DataToFrames({logger: agwLog}, {
    port: 0,
    callTo: localAddress,
    callFrom: remoteAddress,
});
const connection = new server.Connection(dataToFrames, {logger: agwLog});
[socket, sender, receiver, throttle, dataToFrames, connection].forEach(function(emitter) {
    ['error', 'timeout'].forEach(function(event) {
        emitter.on(event, function(err) {
            log.warn('%s emitted %s(%s)',
                     emitter.constructor.name, event, err || '');
        });
    });
});
socket.on('close', function(info) {
    log.trace('socket emitted close(%s)', info || '');
    connection.destroy();
});
connection.on('close', function(info) {
    log.trace('connection emitted close(%s)', info || '');
    dataToFrames.end();
});
dataToFrames.on('end', function(info) {
    log.trace('dataToFrames emitted end(%s)', info || '');
    throttle.end();
});
throttle.on('end', function(info) {
    log.trace('throttle emitted end(%s)', info || '');
    sender.end();
});
sender.on('end', function(info) {
    log.trace('sender emitted end(%s)', info || '');
    socket.destroy();
    process.exit(info ? 2 : 0);
});
dataToFrames.pipe(throttle).pipe(sender).pipe(socket);
throttle.emitFrameFromAGW = function(frame) {
    connection.onFrameFromAGW(frame);
};
receiver.emitFrameFromAGW = function(frame) {
    throttle.onFrameFromAGW(frame);
};
socket.pipe(receiver);

throttle.write({dataKind: 'G'}); // ask about ports
throttle.write({
    port: 0,
    dataKind: 'X', // register call sign
    callFrom: localAddress,
});
throttle.write({
    port: 0,
    dataKind: 'C', // connect
    callFrom: localAddress,
    callTo: remoteAddress,
});
/*
        dataToFrames.on('data', function(info) {
            log.trace('dataToFrames emitted data(%s)', getFrameSummary(info));
            throttle.write(info);
        });
*/

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
        socket.destroy();
        process.exit(3);
    }, 3000);
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

const prompt = 'command> ';
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
                'R <file name>: receive a file from the remote station and disconnect',
                'S <file name>: send a file to the remote station',
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
