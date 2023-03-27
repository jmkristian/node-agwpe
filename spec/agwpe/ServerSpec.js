const AGWPE = require('../../server.js');
const MockNet = require('../mockNet/mockNet.js');
const sinon = require('sinon');

const log = MockNet.log;
const HappyPorts = '2;Port1 stub;Port2 stub';

class happyNet extends MockNet.mockNet {
    constructor(spec) {
        super(spec);
        this.respond = function(chunk, encoding) {
            const request = AGWPE.fromHeader(chunk);
            switch(request.dataKind) {
            case 'G':
                return AGWPE.toFrame(Object.assign({}, request, {
                    data: HappyPorts,
                }), 'binary');
            case 'X':
                return AGWPE.toFrame(Object.assign({}, request, {
                    data: ([0, 1].includes(request.port)
                           ? '\x01' // success
                           : '\x00' // failure
                          ),
                }), 'binary');
            default:
                return null;
            }
        };
    }
}

class noPorts extends MockNet.mockNet {
    constructor(spec) {
        super(spec);
        this.respond = function(chunk, encoding) {
            const request = AGWPE.fromHeader(chunk);
            switch(request.dataKind) {
            case 'G':
                return AGWPE.toFrame(Object.assign({}, request, {
                    data: '0;', // no ports
                }), 'binary');
            case 'X':
                return AGWPE.toFrame(Object.assign({}, request, {
                    data: '\x00', // failure
                }), 'binary');
            default:
                return null;
            }
        };
    }
}

describe('Server', function() {

    const sandbox = sinon.createSandbox();
    let serverOptions, server

    beforeEach(function() {
        serverOptions = {
            host: Math.floor(Math.random() * (1 << 20)).toString(36),
            port: Math.floor(Math.random() * ((1 << 16) - 1)) + 1,
            logger: log,
            Net: new happyNet(this),
        };
        server = new AGWPE.Server(serverOptions);
        server.on('error', function(err) {
            log.debug(err);
        });
    });

    afterEach(function() {
        if (this.server) this.server.close();
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
        const listening = new Promise(function(resolve, reject) {
            server.listen({host: ['N0CALL'], port: 1}, function() {
                resolve();
            });
            try {
                server.listen({host: ['N0CALL'], port: 1});
                fail('listen twice');
            } catch(err) {
                expect(err).toEqual(jasmine.objectContaining({
                    code: 'ERR_SERVER_ALREADY_LISTEN',
                }));
            }
        });
        return expectAsync(listening).toBeResolved();
    });

    it('should callback from listening', function() {
        log.debug('Server should callback from listening');
        const listening = new Promise(function(resolve, reject) {
            server.listen({host: 'N0CALL', port: 0}, function() {
                if (server.listening) {
                    setTimeout(resolve, 500);
                    // The timeout isn't really neccessary, but
                    // it makes the log output more interesting.
                } else {
                    reject('!server.listening');
                }
            });
        });
        return expectAsync(listening).toBeResolved();
    });

    it('should emit listening', function() {
        log.debug('Server should emit listening');
        const listening = new Promise(function(resolve, reject) {
            server.on('listening', function() {
                if (server.listening) {
                    resolve();
                } else {
                    reject('!server.listening');
                }
            });
            server.listen({host: 'N0CALL', port: 1});
        });
        return expectAsync(listening).toBeResolved();
    });

    it('should listen to all ports', function() {
        log.debug('Server should listen to all ports');
        const listening = new Promise(function(resolve, reject) {
            server.on('listening', function() {
                try {
                    var serverAddress = server.address();
                    log.debug('server.address() %o', serverAddress);
                    expect(serverAddress).toEqual(jasmine.objectContaining({
                        host: 'N0CALL',
                        port: [0, 1],
                    }));
                    resolve();
                } catch(err) {
                    reject(err);
                }
            });
            server.listen({host: 'N0CALL'});
        });
        return expectAsync(listening).toBeResolved();
    });

    it('should refuse port numbers out of range', function() {
        log.debug('Server should refuse port numbers out of range');
        [-1, 256].forEach(function(port) {
            try {
                server.listen({host: 'N0CALL', port: port});
                fail('listen accepted port ' + port);
            } catch(err) {
                log.trace('%o from listen', err);
                expect(err.code).toEqual('ERR_INVALID_ARG_VALUE');
                expect(server.listening).toEqual(false);
            }
        });
    });

    it('should connect to TNC', function() {
        log.debug('Server should connect to TNC');
        const connectSpy = sandbox.spy(MockNet.mockSocket.prototype, 'connect');
        const connected = new Promise(function(resolve, reject) {
            server.on('listening', function() {
                expect(server.listening).toEqual(true);
                expect(connectSpy.calledOnce).toBeTruthy();
                expect(connectSpy.getCall(0).args[0])
                    .toEqual(jasmine.objectContaining({
                        host: serverOptions.host,
                        port: serverOptions.port,
                    }));
                resolve();
            });
            server.listen({host: 'N0CALL'});
        });
        return expectAsync(connected).toBeResolved();
    });

    it('should disconnect from TNC', function() {
        log.debug('Server should disconnect from TNC');
        const destroySpy = sandbox.spy(MockNet.mockSocket.prototype, 'destroy');
        const closed = new Promise(function(resolve, reject) {
            server.on('listening', function() {
                expect(server.listening).toEqual(true);
                server.close();
            });
            server.on('close', function(err) {
                expect(destroySpy.calledOnce).toBeTruthy();
                resolve();
            });
            server.listen({host: ['N0CALL']});
        });
        return expectAsync(closed).toBeResolved();
    });

    it('should report a nonexistent port', function() {
        log.debug('Server should report a nonexistent port');
        const reported = new Promise(function(resolve, reject) {
            var listening = false;
            server.on('listening', function(err) {
                listening = true;
            });
            server.on('error', function(err) {
                log.debug('error %o', err);
                expect(err.code).toEqual('ENOENT');
                expect(listening).toEqual(true);
                resolve();
            });
            server.listen({host: 'N0CALL', port: 127});
        });
        return expectAsync(reported).toBeResolved();
    });

    it('should report no ports', function() {
        const spec = this;
        const closed = new Promise(function(resolve, reject) {
            server = new AGWPE.Server(Object.assign({}, serverOptions, {Net: new noPorts(this)}));
            server.on('listening', function(err) {
                reject('listening');
            });
            server.on('error', function(err) {
                expect(err.code).toEqual('ENOENT');
                resolve();
            });
            server.listen({host: 'N0CALL'});
        });
        return expectAsync(closed).toBeResolved();
    });

    it('should report no TNC', function() {
        const spec = this;
        const reported = new Promise(function(resolve, reject) {
            server = new AGWPE.Server(Object.assign(
                {}, serverOptions,
                {Net: new MockNet.noTNC(this)}));
            server.on('listening', function(err) {
                reject('listening');
            });
            server.on('error', function(err) {
                expect(err.code).toEqual(MockNet.ECONNREFUSED);
                resolve();
            });
            server.listen({host: 'N0CALL', port: 0});
        });
        return expectAsync(reported).toBeResolved();
    });

    it('should report no TNC host', function() {
        const spec = this;
        const reported = new Promise(function(resolve, reject) {
            server = new AGWPE.Server(Object.assign(
            {}, serverOptions,
            {Net: new MockNet.noTNCHost(this)}));
            server.on('listening', function(err) {
                reject('listening');
            });
            server.on('error', function(err) {
                expect(err.code).toEqual(MockNet.ETIMEDOUT);
                resolve();
            });
            server.listen({host: 'N0CALL', port: 1})
        });
        return expectAsync(reported).toBeResolved();
    });

}); // Server
