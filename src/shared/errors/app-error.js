export class AppError extends Error {
  constructor(statusCode, code, message, details = []) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', details = []) {
    super(404, 'NOT_FOUND', message, details);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(code, message, details = []) {
    super(409, code, message, details);
    this.name = 'ConflictError';
  }
}

export class BadRequestError extends AppError {
  constructor(code, message, details = []) {
    super(400, code, message, details);
    this.name = 'BadRequestError';
  }
}
