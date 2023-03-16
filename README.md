# node-agwpe
Communicate via AX.25 in the style of
[node net](https://nodejs.org/docs/latest-v8.x/api/net.html),
using an AGWPE-compatible TNC.

```js
const AGWPE = require('node-agwpe');
const Bunyan = require('bunyan');

var server = new AGWPE.Server ({
    host: 'agwpe-server-host', // default: localhost
    port: 8000, // default: 8000
    frameLength: 128, /* default: 128
        The maximum number of bytes to transmit to AGWPE in one data frame.
        The effect of frameLength varies, depending on the AGWPE TNC.
        SoundModem by UZ7HO transmits a long data frame as one long packet.
        Direwolf breaks up a long frame into packets of PACLEN bytes each.
        Large values may not work at all; for example Direwolf v1.7a will
        reset the TCP connection if you send much more than 2 KBytes.
        */
    logger: Bunyan.createLogger({name: "myapp"}), /* default: no logging
        An object compatible with the Bunyan logger interface, or null.
        */
});
server.on('connection', function(connection) {
    console.log('connection'
                + ' from ' + connection.theirCall
                + ' to ' + connection.myCall);
    connection.write(...); // transmit data
    connection.pipe(...); // receive data
});
server.listen({
        callTo: ['A1CALL-1', 'B2CALL-10']  // This server's call signs.
    },
    function onListening(info) { // called when the server begins listening
        console.log('AGWPE listening ' + (info || ''));
    });
```
