# node-agwpe
Communicate via AX.25 in the style of node net, using an AGWPE-compatible TNC.

```js
const AGWPE = require('agwpe');
var server = new AGWPE.Server ({
    host: 'agwpe-server-host', // default: localhost
    port: 8000, // default: 8000
    frameLength: 128, /* default: 128
        The maximum number of bytes to transmit to AGWPE a data frame.
        The effect of frameLength varies, depending on the AGWPE TNC.
        SoundModem by UZ7HO transmits a long data frame as one long
        packet. Direwolf breaks up a long frame into packets of PACLEN
        bytes each. Large values may not work at all; for example
        Direwolf v1.7a will reset the TCP connection if you send much
        more than 2 KBytes.
        */
    logger: bunyan.createLogger({name: "myapp"}), /* default: no logging
        An object compatible with the Bunyan logger interface, or null.
        */
});
server.on('connection', function(connection) {
    console.log('connection from ' + connection.theirCall);
    connection.write(...); // transmit data
    connection.pipe(...); // process data received
});
server.listen({
        callTo: ['NOCALL-1']  // A space-separated list of this server's call signs.
    },
    function onListening(info) { // called when the server begins listening
        log.info(`${section} listening %o`, info);
    });
```
