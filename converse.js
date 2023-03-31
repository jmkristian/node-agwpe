const Bunyan = require('bunyan');
const minimist = require('minimist');
const mockNet = require('./spec/mockNet/mockNet.js');
const Net = require('net');
const OS = require('os');
const path = require('path');
const Readline = require('readline');
const server = require('./server.js');
const Stream = require('stream');

/* TODO:
Rename this program to 'converse'.
*/

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
const remoteEOL = args.eol || '\r';
const ESC = args.esc || '\x1D'; // Ctrl+]
const ID = args.id;
const via = Array.isArray(args.via) ? args.via.join(' ') : args.via;
const EOLPattern = new RegExp(remoteEOL, 'g');

if (!(localAddress && remoteAddress)) {
    const myName = path.basename(process.argv[0])
          + ' ' + path.basename(process.argv[1]);
    process.stderr.write([
        `usage: ${myName} [options] localCallSign remoteCallSign`,
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
    log.debug('socket emitted close(%s)', info || '');
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
[ // Close gracefully:
    'SIGHUP', // disconnected or console window closed
    'SIGINT', // Ctrl+C
].forEach(function(signal) {
    process.on(signal, function(s) {
        log.info('%s disconnecting...', signal);
        connection.destroy();
        setTimeout(function() {
            socket.destroy();
            process.exit(3);
        }, 3000);
    });
});

const watcher = new Stream.Transform({
    transform: function(chunk, encoding, callback) {
        const data = chunk.toString('utf-8');
        const b = data.indexOf(ESC);
        if (b < 0) {
            if (log.trace()) log.trace('watcher push ' + JSON.stringify(data));
            this.push(chunk, encoding);
        } else {
            log.trace('watcher emit break');
            this.emit('break');
            const d = data.substring(0, b) + data.substring(b + ESC.length);
            if (log.trace()) log.trace('watcher push ' + JSON.stringify(d));
            this.push(d, 'utf-8');
        }
        if (callback) callback();
    },
});
const user = Readline.createInterface({
    input: watcher,
    output: process.stdout,
    prompt: '',
});
const prompt = 'command> ';
var conversing = true;
if (conversing) {
    console.log(`Type ${controlify(ESC)} to enter command mode.`);
} else {
    process.stdout.write(prompt);
}
watcher.on('break', function() {
    conversing = false;
    process.stdout.write(OS.EOL + prompt);
});
user.on('close', function(err) {
    connection.destroy();
});
user.on('line', function(line) {
    if (log.debug()) log.debug('user line ' + JSON.stringify(line));
    if (conversing) {
        const data = line.replace(/\r?\n/g, remoteEOL);
        log.debug('transmit %s', JSON.stringify(data));
        connection.write(data + remoteEOL, 'utf-8');
    } else { // command mode
        switch (line.trim().split(/\s+/)[0].toLowerCase()) {
        case '':
            break;
        case 'b': // disconnect
            connection.destroy();
            user.close();
            return;
        case 'c': // converse
            console.log(`Type ${controlify(ESC)} to return to command mode.`)
            conversing = true;
            break;
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
            console.log(`Type 'H' to see a list of commands.`);
        }
        if (!conversing) process.stdout.write(prompt);
    }
});
if (process.stdin.setRawMode) {
    process.stdin.setRawMode(true);
}
process.stdin.pipe(watcher).pipe(user);
connection.on('data', function(data) {
    log.debug('received %s', JSON.stringify(data));
    process.stdout.write(data.toString('utf-8').replace(EOLPattern, OS.EOL));
});
