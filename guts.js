'use strict';

function newError(message, code) {
    const err = new Error(message);
    if (code) err.code = code;
    return err;
}

function validateCallSign(name, value) {
    if (!value) throw newError(`The ${name} call sign is "${value}".`,'ERR_INVALID_ARG_VALUE');
    var end = value.indexOf('-');
    if (end < 0) end = value.length;
    if (end > 6) {
        throw newError(`The ${name} call sign "${value.substring(0, end)}" is too long.`
                       + ` The limit is 6 characters.`,
                       'ERR_INVALID_ARG_VALUE');
    }
    if (end < value.length - 1) {
        const SSID = value.substring(end + 1);
        const n = parseInt(SSID);
        if (!(n >= 0 && n <= 15)) {
            throw newError(`The ${name} SSID "${SSID}" is outside the range 0..15.`,
                           'ERR_OUT_OF_RANGE');
        }
    }
    return value.toUpperCase();
}

function validatePort(port) {
    if (port == null) throw newError(`The TNC port is "${port}".`,'ERR_INVALID_ARG_VALUE');
    var result = parseInt(`${port}`);
    if (!(result >= 0 && result <= 255)) {
        throw newError(`TNC port "${port}" is outside the range 0..255.`,
                       'ERR_OUT_OF_RANGE');
    }
    return result;
}

exports.newError = newError;
exports.validateCallSign = validateCallSign;
exports.validatePort = validatePort;
