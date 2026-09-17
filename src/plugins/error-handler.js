export function errorHandler(error, request, reply) {
  if (error.validation) {
    request.log.warn({ code: 'VALIDATION_ERROR', details: error.validation }, error.message);
    return reply.status(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: error.validation
      }
    });
  }

  const statusCode = error.statusCode ?? 500;
  const isClientError = statusCode < 500;

  // 5xx is a real defect — log with stack. 4xx is routine (auth, not-found,
  // conflicts) — log a line, no stack trace.
  if (isClientError) {
    request.log.warn({ code: error.code, statusCode }, error.message);
  } else {
    request.log.error(error);
  }

  return reply.status(statusCode).send({
    error: {
      code: error.code ?? 'INTERNAL_SERVER_ERROR',
      message: isClientError ? error.message : 'An unexpected error occurred',
      details: isClientError ? (error.details ?? []) : []
    }
  });
}
