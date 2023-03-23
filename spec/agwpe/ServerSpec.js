const AGWPE = require('../../server.js');
const Bunyan = require('bunyan');
const Net = require('net');
const sinon = require('sinon');
const Stream = require('stream');
const util = require('util');

const logStream = new Stream();
const log = Bunyan.createLogger({
    name: 'ServerSpec',
    level: Bunyan.INFO,
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
const LogNothing = Bunyan.createLogger({
    name: 'ServerSpec',
    level: Bunyan.FATAL + 100,
});

const GResponseData = '1;Port1 stub';

let aSocket = null;

class Responder extends Stream.Writable {
    constructor(target, log) {
        super({
            objectMode: true, // each object is an AGWPE frame
        });
        this.target = target;
        this.log = log || LogNothing;
    }
    _write(request, encoding, callback) {
        try {
            this.log.trace(`Responder._write(%o, %s, %s)`, request, encoding, typeof callback);
            var response = null;
            switch(request.dataKind) {
            case 'G':
                response = Object.assign({}, request, {
                    dataKind: 'G',
                    data: GResponseData,
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
                if (response.data && !(typeof response.data) == 'string') {
                    response.data = response.data.toString(encoding);
                }
                this.target.toReader(response);
            }
            if (callback) callback();
        } catch(err) {
            if (callback) callback(err);
        }
    }
}

class stubReader extends AGWPE.Reader {
    constructor(options) {
        super(options);
    }
}

class stubSocket extends Stream.Duplex {
    constructor(options) {
        super({
            readable: true, // default
            writable: true, // default
        });
        this.log = options ? (options.logger || LogNothing) : log;
        this.log.debug('stubSocket new(%o)', options);
        this._read_buffer = [];
        this._pushable = false;
        this.reader = new stubReader({logger: this.log});
        this.responder = new Responder(this, this.log);
        this.reader.pipe(this.responder);
        this.on('pipe', function(from) {
            this.log.debug('stubSocket pipe from %s', from.constructor.name);
        });
        this.on('unpipe', function(from) {
            this.log.debug('stubSocket unpipe from %s', from.constructor.name);
        });
        aSocket = this;
    }
    connect(options, callback) {
        this.log.debug(`stubSocket.connect(%s, %s)`, options, typeof callback);
        if (callback) callback();
    }
    _destroy(err, callback) {
        this.emit('close');
        if (callback) callback();
    }
    _write(data, encoding, callback) {
        this.reader.write(data, encoding, callback);
    }
    _read(size) {
        this.log.trace(`stubSocket._read(%d)`, size);
        this._pushable = true;
        setTimeout(function(that) {
            that.pushMore();
        }, 10, this);
    }
    pushMore() {
        while (this._pushable && this._read_buffer.length > 0) {
            const response = this._read_buffer.shift();
            const frame = AGWPE.toFrame(response);
            this.log.trace('stubSocket.push %d %o', frame.length, response);
            this._pushable = this.push(frame);
            // this.emit('readable');
        }
    }
    toReader(response) {
        this.log.trace('stubSocket.toReader %o', response);
        this._read_buffer.push(response);
        this.pushMore();
    }
}

function exposePromise() {
    const result = {};
    result.promise = new Promise(function(resolve, reject) {
        result.resolve = resolve;
        result.reject = reject;
    });
    return result;
}

describe('stubSocket', function() {

    let socket

    beforeEach(function() {
        socket = new stubSocket({logger: log});
    });

    afterEach(function() {
        socket.destroy();
    });

    it('should pipe a response', function() {
        log.info('stubSocket should pipe a response');
        const request = exposePromise();
        const response = new Promise(function(resolve, reject) {
            const reader = new AGWPE.Reader({logger: log});
            reader.pipe(new Stream.Writable({
                objectMode: true,
                write: function(actual, encoding, callback) {
                    log.debug('received %o', actual);
                    if (actual.dataKind == 'X' && actual.port == 21 && actual.data == '\x01') {
                        resolve();
                    } else {
                        reject(actual);
                    }
                },
            }));
            socket.connect(null, function() {
                socket.pipe(reader);
                // send the request:
                socket.write(AGWPE.toFrame({dataKind: 'X', port: 21}), null, function(err) {
                    if (err) request.reject(err);
                    else request.resolve();
                });
            });
        });
        return expectAsync(Promise.all([request.promise, response])).toBeResolved();
    });

    it('should pipe 2 responses', function() {
        log.info('stubSocket should pipe 2 responses');
        // Send some requests:
        const requests = [
            {dataKind: 'G'},
            {dataKind: 'X', port: 1, callFrom: 'N0CALL'},
        ];
        // Expect some responses:
        const expected = [
            [exposePromise(), {dataKind: 'G', data: GResponseData}],
            [exposePromise(), {dataKind: 'X', port: 1, data: '\x01'}],
        ];
        const results = expected.map(e => e[0].promise);
        var expectIndex = 0;
        const reader = new AGWPE.Reader({logger: log});
        reader.pipe(new Stream.Writable({
            objectMode: true,
            write: function(actual, encoding, callback) {
                log.debug('response %o', actual);
                var failure = undefined;
                const item = expected[expectIndex++];
                const result = item[0];
                const expect = item[1];
                for (key in expect) {
                    if (actual[key] != expect[key]) {
                        failure = actual;
                        break;
                    }
                }
                if (failure) {
                    result.reject(failure);
                } else {
                    result.resolve();
                }
                if (callback) callback();
            },
        }));
        socket.connect(null, function() {
            socket.pipe(reader);
            // Send the requests:
            var requestIndex = 0;
            new Stream.Readable({
                read: function(size) {
                    if (requestIndex < requests.length) {
                        const request = requests[requestIndex++];
                        log.debug('request %o', request);
                        this.push(AGWPE.toFrame(request));
                    }
                },
            }).pipe(socket);
        });
        return expectAsync(Promise.all(results)).toBeResolved();
    });

}); // stubSocket

describe('Server', function() {

    const sandbox = sinon.createSandbox();
    let server, serverOptions

    beforeEach(function() {
        serverOptions = {
            host: Math.floor(Math.random() * (1 << 20)).toString(36),
            port: Math.floor(Math.random() * ((1 << 16) - 1)) + 1,
            logger: log,
        };
        server = new AGWPE.Server(serverOptions);
        server.on('error', function(err) {
            log.error(err);
        });
    });

    afterEach(function() {
        server.close();
        sandbox.restore();
    });

    it('should not close when closed', function() {
        server.close(function(err) {
            expect(err).toBeTruthy();
        });
    });

    it('should require TNC port', function() {
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

    it('should not listen when listening', function() {
        var actual = null;
        server.listen({host: ['N0CALL'], Socket: stubSocket});
        try {
            server.listen({host: ['N0CALL'], port: 3, Socket: stubSocket});
            fail();
        } catch(err) {
            actual = err;
        }
        expect(actual).toEqual(jasmine.objectContaining({
            code: 'ERR_SERVER_ALREADY_LISTEN',
        }));
    });

    it('should emit listening', function() {
        log.info('Server should emit listening');
        const listening = new Promise(function(resolve, reject) {
            server.listen({
                host: 'N0CALL', port: 1, Socket: stubSocket,
            }, function() {
                if (server.listening) {
                    setTimeout(resolve, 500);
                } else {
                    reject('!server.listening');
                }
            });
        });
        return expectAsync(listening).toBeResolved();
    });

    it('should connect to AGWPE TNC', function() {
        log.info('Server should connect to AGWPE TNC');
        const connectSpy = sandbox.spy(stubSocket.prototype, 'connect');
        const connected = new Promise(function(resolve, reject) {
            server.listen({host: ['N0CALL'], port: 1, Socket: stubSocket}, function() {
                expect(connectSpy.calledOnce).toBeTruthy();
                expect(connectSpy.getCall(0).args[0])
                    .toEqual(jasmine.objectContaining({
                        host: serverOptions.host,
                        port: serverOptions.port,
                    }));
                resolve();
            });
        });
        return expectAsync(connected).toBeResolved();
    });

    it('should disconnect from AGWPE TNC', function() {
        log.info('Server should disconnect from AGWPE TNC');
        const destroySpy = sandbox.spy(stubSocket.prototype, 'destroy');
        const closed = new Promise(function(resolve, reject) {
            server.on('close', function(err) {
                expect(destroySpy.calledOnce).toBeTruthy();
                resolve();
            });
            server.listen({host: 'N0CALL', port: 1, Socket: stubSocket}, function() {
                setTimeout(function() {
                    log.info('server.close()');
                    server.close();
                }, 500);
            });
        });
        return expectAsync(closed).toBeResolved();
    });

}); // Server
