export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

export class RelayError extends Error {
  constructor(message, { code = "relay_error", status = 500, details = undefined } = {}) {
    super(message);
    this.name = "RelayError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function errorPayload(error, requestId) {
  const payload = {
    error: {
      type: error.name === "RelayError" ? error.code : "internal_error",
      message: error.message,
      request_id: requestId
    }
  };
  if (error.details !== undefined) {
    payload.error.details = error.details;
  }
  return payload;
}
