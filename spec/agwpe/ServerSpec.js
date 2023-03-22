const Bunyan = require('bunyan');
const Net = require('net');
const Stream = require('stream');
const AGWPE = require('../../server.js');

const logStream = new Stream();
const logger = Bunyan.createLogger({
    name: 'ServerSpec',
    level: Bunyan.TRACE,
    streams: [{
        type: "raw",
        stream: logStream,
    }],
});
logStream.writable = true;
logStream.write = function(item) {
    var c = item['class'];
    c = c ? c + ' ' : '';
    console.log(`${item.level}: ${c}${item.msg}`);
}

// const realSocket = Net.Socket;
var aSocket = null;

class mockSocket extends Stream.Duplex {
    constructor(options) {
        super({
//            readableObjectMode: false,
//            writableObjectMode: false,
        });
        logger.debug('new mockSocket(%o)', options);
        // this.receive_buffer = [];
        // spyOn(this, 'on');
        // spyOn(this, 'pipe');
        // spyOn(this, 'connect'); // doesn't work
        // spyOn(this, 'destroy'); // doesn't work
        // spyOn(this, '_write'); // doesn't work
        aSocket = this; 
    }
    connect(options, callback) {
        logger.debug(`connect(%s, %s)`, options, typeof callback);
        if (callback) callback('not really an error');
    }
    _destroy(err, callback) {
        this.emit('close');
        if (callback) callback(err);
    }
    _read(size) {
        logger.trace(`mockSocket._read(${size})`);
        this.receiveBufferIsFull = false;
/*
        while (this.receive_buffer.length) {
            var response = this.receive_buffer.shift();
            logger.debug('push%o', response);
            if (this.push(AGWPE.toFrame(response))) break;
        }
*/
    }
    _write(data, encoding, callback) {
        const request = AGWPE.fromHeader(data);
        logger.debug(`_write(%o, %s, %s)`, request, encoding, typeof callback);
        var response = null;
        switch(request.dataKind) {
        case 'G':
            response = Object.assign({}, request, {
                dataKind: 'G',
                data: '0;Port0 mockSocket port',
            });
            break;
        case 'X':
            response = Object.assign({}, request, {
                dataKind: 'X',
                data: '\x01', // success
            });
            break;
        default:
        }
        if (response) {
            if (this.receiveBufferIsFull) {
                logger.warn('lost %o', response);
            } else {
                logger.debug('respond%o', response);
                this.push(AGWPE.toFrame(response));
                // this.receive_buffer.push(response);
                this.emit('readable');
            }
        }
        if (callback) callback();
    }
}

describe('mockSocket', function() {

    let subject

    beforeEach(function() {
        subject = new mockSocket();
    });

    afterEach(function() {
        try {
            subject.close();
        } catch(err) {
            logger.warn(err, 'mockSocket.close');
        }
    });

    it('should read a response', function() {
        var resolveErr;
        const err = new Promise(function(resolve, reject) {
            resolveErr = resolve;
        });
        subject.write(AGWPE.toFrame({
            dataKind: 'X',
            port: 12,
        }), null, function(err) {
            resolveErr(err ? Promise.reject(err) : undefined);
        });
        var actual = subject.read();
        expect(actual).toBeInstanceOf(Buffer);
        expect(AGWPE.fromHeader(actual)).toEqual(jasmine.objectContaining({
            dataKind: 'X',
            port: 12,
        }));
        return expectAsync(err).toBeResolved();
    });

    it('should pipe a response', function() {
        var resolveActual;
        const actual = new Promise(function(resolve, reject) {
            resolveActual = resolve;
        });
        var resolveErr;
        const err = new Promise(function(resolve, reject) {
            resolveErr = resolve;
        });
        subject.write(AGWPE.toFrame({
            dataKind: 'X',
            port: 21,
        }), null, function(err) {
            resolveErr(err ? Promise.reject(err) : undefined);
        });
        subject.pipe(new Stream.Writable({
            write: function(chunk, encoding, callback) {
                if (!Buffer.isBuffer(chunk)) {
                    resolveActual(Promise.reject('chunk is a ') + (typeof chunk));
                } else {
                    var actual = AGWPE.fromHeader(chunk);
                    if (actual.dataKind == 'X' && actual.port == 21) {
                        resolveActual();
                    } else {
                        resolveActual(Promise.reject(actual));
                    }
                }
            },
        }));
        return expectAsync(Promise.all([err, actual])).toBeResolved();
    });

}); // mockSocket
/*
describe('Server', function() {

    let server, serverOptions

    beforeAll(function() {
//        Net.Socket = mockSocket;
    });

    afterAll(function() {
//        Net.Socket = realSocket;
    });

    beforeEach(function() {
        serverOptions = {
            host: Math.floor(Math.random() * (1 << 20)).toString(36),
            port: Math.floor(Math.random() * ((1 << 16) - 1)) + 1,
            logger: logger,
        };
        server = new AGWPE.Server(serverOptions);
        server.on('error', function(err) {
            logger.error(err);
        });
    });

    afterEach(function() {
        try {
            server.close();
        } catch(err) {
        }
    });

    it('should not close when closed', function() {
        server.close(function(err) {
            expect(err).toBeTruthy();
        });
    });

    it('should require TNC port', function() {
        new AGWPE.Server({port: serverOptions.port});
        try {
            new AGWPE.Server();
            fail('no options');
        } catch(err) {
        }
        try {
            new AGWPE.Server({host: serverOptions.host});
            fail('no options.port');
        } catch(err) {
        }
    });

    it('should require the host', function() {
        try {
            server.listen({});
            fail('no options.host');
        } catch(err) {
        }
    });

    it('should emit listening', function() {
        var listening = false;
        server.listen({host: 'N0CALL', port: 1, Socket: mockSocket}, function() {
            listening = true;
        });
        expect(listening).toBe(true);
        expect(server.listening).toBe(true);
    });

    it('should connect to AGWPE TNC', function() {
        spyOn(mockSocket.prototype, 'connect');
        server.listen({host: ['N0CALL']});
        expect(aSocket.on).toHaveBeenCalled();
        expect(aSocket.pipe).toHaveBeenCalledTimes(1);
        expect(aSocket.connect).toHaveBeenCalledWith(
            jasmine.objectContaining({
                host: serverOptions.host,
                port: serverOptions.port,
            }),
            jasmine.any(Function)
        );
    });

    it('should disconnect from AGWPE TNC', function() {
        var closed = false;
        spyOn(mockSocket.prototype, 'destroy');
        server.listen({host: 'N0CALL'});
        server.on('close', function(err) {
            closed = true;
        });
        server.close();
        expect(closed).toBe(true);
        expect(aSocket.destroy).toHaveBeenCalled();
    });

    it('should not listen when listening', function() {
        var actual = null;
        server.listen({host: ['N0CALL'], port: 2});
        try {
            server.listen({host: ['N0CALL'], port: 3});
            fail();
        } catch(err) {
            actual = err;
        }
        expect(actual).toEqual(jasmine.objectContaining({
            code: 'ERR_SERVER_ALREADY_LISTEN',
        }));
    });

}); // Server
*/
