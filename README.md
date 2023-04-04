# node-agwpe
Communicate via AX.25, using an AGWPE-compatible TNC (e.g.
[Direwolf](https://github.com/wb2osz/direwolf),
[SoundModem](http://uz7.ho.ua/packetradio.htm) or
[AGWPE](https://www.sv2agw.com/downloads/)).

This package includes a program `converse`,
which you can use to interact with another station.
It runs in a terminal emulator or Windows "cmd" window, similar to the `telnet` or `ssh` programs.
You can watch a [demonstration video](https://youtu.be/MwgSv3Ae3Z0/).
To get started:

1. [Clone](https://www.techrepublic.com/article/how-to-clone-github-repository/) this repository.
2. Start a command interpreter (e.g. Windows cmd or Linux shell) in your clone.
3. Check whether node.js is installed, by running the command `node --version`.
   If not, [install node.js](https://nodejs.org/en/download/).
   You'll need node version 8.0 or later.
   If you need to upgrade, use `nvm` to
   [install a new version](https://heynode.com/tutorial/install-nodejs-locally-nvm/).
4. Download node modules, by running the command `npm install`.
   Ignore messages about finding Python; they're harmless.
5. Run the command `node ./converse.js <your call sign> <remote call sign> --verbose`.

To see a summary of the command line options, run `node ./converse.js` (with no parameters).
Once you're familiar with using the program, you might like to omit the `--verbose` option.

This software requires [node.js](https://nodejs.org/en/) version 8 or later.
It works on Windows and Linux, with
[Direwolf](https://github.com/wb2osz/direwolf) version 1.7
and [UZ7HO SoundModem](http://uz7.ho.ua/packetradio.htm) version 1.13.
It might work with other versions or on Mac.

You can also use this package to develop your own software.
To get started, navigate to your package and run:
```bash
npm install @jmkristian/node-agwpe
```

The programming interface is similar to
[node Net](https://nodejs.org/docs/latest-v8.x/api/net.html).
Here's some sample code.

Connect to another station:
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
    frameLength: 128, /* default: 128
        The maximum number of bytes to transmit to the TNC in one data frame.
        The effect of frameLength varies, depending on the TNC.
        SoundModem by UZ7HO transmits a long data frame as one long packet.
        Direwolf breaks up a long frame into packets of PACLEN bytes each.
        Large values may not work at all; for example Direwolf v1.7a will
        reset the TCP connection if you send much more than 2 KBytes. */
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
