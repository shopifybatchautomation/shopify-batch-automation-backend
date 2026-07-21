const globalErrorHandler = (err, req, res, _next) => {
  const statusCode = err.statusCode || 500;
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
  return res.status(statusCode).json({
    success: false,
    message: err.message || 'Internal Server Error',
    errors: err.errors || [],
    data: null,
  });
};

export { globalErrorHandler };
