'use strict';

class DzWalletError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}
class ConfigurationError extends DzWalletError {}
/** Timeout or network error. After initiatePayment the outcome is UNKNOWN: call paymentStatus() first. */
class ConnectionError extends DzWalletError {}
class InvalidSignatureError extends DzWalletError {}
class ApiError extends DzWalletError {
  constructor(message, errors = [], httpStatus = null) {
    super(message);
    this.errors = errors;
    this.httpStatus = httpStatus;
  }
  get isRateLimited() {
    return this.httpStatus === 429;
  }
}

module.exports = { DzWalletError, ConfigurationError, ConnectionError, InvalidSignatureError, ApiError };
