const process = require('process');

describe('node.js', function() {

    it('should be compatible with Jasmine', function() {
        const version = process.versions.node;
        var parts = version.split('.').map(s => parseInt(s));
        expect(parts[0] % 2).toEqual(0); // no odd-number versions
        if (parts[0] <= 12) { // minimum 12.17
            expect(parts[0]).toEqual(12);
            expect(parts[1]).toBeGreaterThanOrEqual(17);
        }
    });

}); // node.js
