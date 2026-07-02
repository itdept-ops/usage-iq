using Microsoft.AspNetCore.Diagnostics;

namespace Ccusage.Api.Infrastructure;

/// <summary>Logs unhandled exceptions and returns a safe, generic 500 (no stack traces to clients).</summary>
public sealed class GlobalExceptionHandler(ILogger<GlobalExceptionHandler> logger) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext context, Exception exception, CancellationToken ct)
    {
        logger.LogError(exception, "Unhandled exception on {Method} {Path} (TraceId {TraceId})", context.Request.Method, context.Request.Path, context.TraceIdentifier);

        context.Response.StatusCode = StatusCodes.Status500InternalServerError;
        await context.Response.WriteAsJsonAsync(new
        {
            title = "An unexpected error occurred.",
            status = 500,
            traceId = context.TraceIdentifier,
        }, ct);

        return true;
    }
}
