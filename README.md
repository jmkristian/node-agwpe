# node-agwpe
Communicate via [AX.25](https://www.tapr.org/pdf/AX25.2.2.pdf),
using an AGWPE-compatible TNC (e.g.
[Direwolf](https://github.com/wb2osz/direwolf),
[SoundModem](http://uz7.ho.ua/packetradio.htm) or
[AGWPE](https://www.sv2agw.com/downloads/)).

To get started, navigate to your package and run:
```bash
npm install @jmkristian/node-agwpe
```
The programming interface is similar to
[node Net](https://nodejs.org/docs/latest-v8.x/api/net.html).
For example, connect to another station:
```js
const AGWPE = require('@jmkristian/node-agwpe');

const connection = AGWPE.createConnection ({
    remoteAddress: 'their call sign',
    localAddress: 'your call sign',
    localPort: 0, // TNC port (sound card). default: 0
    host: 'TNC-server-host', // TNC's TCP host. default: 127.0.0.1
    port: 8000, // TNC's TCP port. default: 8000
}, function connectListener() {
    connection.write(...); // transmit data
    connection.pipe(...); // receive data
});
connection.on('error', function(err) {console.log('Uh oh! ' + err);})
```

Listen for incoming connections:
```js
const AGWPE = require('@jmkristian/node-agwpe');
const Bunyan = require('bunyan');

var server = new AGWPE.Server ({
    host: 'tnc-server-host', // TNC's TCP host. default: 127.0.0.1
    port: 8000, // TNC's TCP port. default: 8000
    logger: Bunyan.createLogger({name: "AGWPE"}), /* default: no logging
        An object compatible with the Bunyan logger interface, or null. */
});
server.on('connection', function(connection) {
    console.log('connection'
                + ' from ' + connection.remoteAddress
                + ' to ' + connection.localAddress);
    connection.write(...); // transmit data
    connection.pipe(...); // receive data
});
server.listen({
        host: ['A1CALL-1', 'B2CALL-10'], // This server's call signs.
        port: [0, 1], // TNC ports to listen to. Default: all ports
    },
    function onListening(info) { // called when the server begins listening
        console.log('TNC listening %o', info);
    });
```
Monitor all received packets or send any packet:
```js
var socket = server.createSocket({
    recvBufferSize: 8, // The default is 16 packets
    sendBufferSize: 3, // The default is 16 packets
});
socket.on('error', function(err) {
    console.log('bind failed ' + err);
}
socket.bind(function success() {
    socket.pipe(...);
    socket.write({
        port: 0,
        type: 'UI',
        toAddress: 'ID',
        fromAddress: 'TAC',
        info: Buffer.from('A1CALL'),
    });
});
```
This is somewhat similar to
[dgram](https://nodejs.org/docs/latest-v8.x/api/dgram.html) sockets.
Unlike dgram, a socket is a
[duplex stream](https://nodejs.org/docs/latest-v8.x/api/stream.html#stream_class_stream_duplex)
operating in object mode.
Each object in the stream represents a packet, with various possible fields:
```js
{
    port: 0, // TNC port (usually identifies a sound card)
    type: 'UI', // or 'I', 'SABM', 'RR' etc.
    toAddress: 'A6CALL', // the call sign of the intended receiver
    fromAddress: 'N0CALL', // the call sign of the sender
    via: ['DIGIA*', 'DIGIB*', 'DIGIC'], // digipeater call signs
    info: Buffer.from([0x56, 0x23, ...]), // data in an I or UI packet
    NS: 7, // N(S) sequence number of this packet
    NR: 3, // N(R) acknowledges a previous packet
    PID: 2, // protocol ID
    command: true,
    response: true,
    P: true, // poll
    F: true, // final
}
```
Most of these fields are optional. Many combinations are invalid.

In the ``via`` array, call signs with an asterisk at the end represent
digipeaters that retransmitted the packet.

Every packet the TNC receives on any port will appear in the Readable stream,
regardless of whether the server is listening for them.
Packets transmitted by this TNC don't appear in the Readable stream.

Received packets may be discarded if nobody reads from the socket or
pipes it to something. (The flow of received packets can't be controlled.)
Transmission is flow controlled: a pipeline might stop flowing or writers
might see slow callbacks, if packets are offered faster than the TNC can
transmit them. Written packets might be discarded if a writer doesn't
wait for callbacks.

This package requires node.js version 8.17.0 or later.
It works on Windows 8 and Ubuntu 20, with
[Direwolf](https://github.com/wb2osz/direwolf) version 1.7
and [UZ7HO SoundModem](http://uz7.ho.ua/packetradio.htm) version 1.13.
It might work with other versions or on Mac.
