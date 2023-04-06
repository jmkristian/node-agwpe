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
This package requires node.js version 8 or later.
It works on Windows 8 and Ubuntu 20, with
[Direwolf](https://github.com/wb2osz/direwolf) version 1.7
and [UZ7HO SoundModem](http://uz7.ho.ua/packetradio.htm) version 1.13.
It might work with other versions or on Mac.
